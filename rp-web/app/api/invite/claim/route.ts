import { NextResponse } from "next/server";
import { getPool } from "@/lib/pg";

export const runtime = "nodejs"; // IMPORTANT: pg requires Node runtime (not edge)

type Body = { email?: string; code?: string };

function normEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function POST(req: Request) {
  const { email, code } = (await req.json()) as Body;

  if (!email || !code) {
    return NextResponse.json({ ok: false, error: "Missing email or code" }, { status: 400 });
  }

  const e = normEmail(email);
  const c = code.trim();

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // If there's already an active claim for this email+code, don't burn another use.
    const existing = await client.query(
      `
      select id
      from invite_claims
      where email = $1
        and code = $2
        and expires_at > now()
        and consumed_at is null
      order by created_at desc
      limit 1
      `,
      [e, c]
    );

    if (existing.rowCount > 0) {
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, reused: true });
    }

    // Lock the invite code row so uses increments safely under concurrency
    const inv = await client.query(
      `
      select code, is_active, max_uses, uses
      from invite_codes
      where code = $1
      for update
      `,
      [c]
    );

    if (inv.rowCount === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ ok: false, error: "Invalid invite code" }, { status: 401 });
    }

    const row = inv.rows[0];
    if (!row.is_active) {
      await client.query("ROLLBACK");
      return NextResponse.json({ ok: false, error: "Invite code inactive" }, { status: 401 });
    }

    const maxUses: number | null = row.max_uses;
    const uses: number = row.uses ?? 0;
    if (maxUses !== null && uses >= maxUses) {
      await client.query("ROLLBACK");
      return NextResponse.json({ ok: false, error: "Invite code exhausted" }, { status: 401 });
    }

    await client.query(`update invite_codes set uses = uses + 1 where code = $1`, [c]);

    // 15-minute claim window (tweak as you like)
    await client.query(
      `
      insert into invite_claims (email, code, expires_at)
      values ($1, $2, now() + interval '15 minutes')
      `,
      [e, c]
    );

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, reused: false });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  } finally {
    client.release();
  }
}
