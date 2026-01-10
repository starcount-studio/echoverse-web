import NextAuth from "next-auth";
import EmailProvider from "next-auth/providers/email";
import PostgresAdapter from "@auth/pg-adapter";
import { getPool } from "@/lib/pg";

export const runtime = "nodejs";

const pool = getPool();

const authHandler = NextAuth({
  adapter: PostgresAdapter(pool, {
	  usersTable: "auth_users",
	  accountsTable: "auth_accounts",
	  sessionsTable: "auth_sessions",
	  verificationTokensTable: "auth_verification_tokens",
	}),

  providers: [
    EmailProvider({
      server: process.env.EMAIL_SERVER,
      from: process.env.EMAIL_FROM,
    }),
  ],

  pages: {
    signIn: "/signin",
    error: "/signin",
  },

  callbacks: {
    async signIn({ user, account }) {
      // Gate ONLY email magic-link style sign-ins
      const provider = account?.provider;
      if (provider !== "email") return true;

      const email = user.email?.trim().toLowerCase();
      if (!email) return false;

      const client = await pool.connect();
      try {
        const claim = await client.query(
          `
          select id
          from invite_claims
          where email = $1
            and expires_at > now()
            and consumed_at is null
          order by created_at desc
          limit 1
          `,
          [email]
        );

        if (claim.rowCount === 0) return false;

        // consume claim so it can't be reused
        await client.query(
          `update invite_claims set consumed_at = now() where id = $1`,
          [claim.rows[0].id]
        );

        return true;
      } finally {
        client.release();
      }
    },
  },
});

export { authHandler as GET, authHandler as POST };
