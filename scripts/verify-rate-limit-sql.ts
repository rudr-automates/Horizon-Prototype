/**
 * Exercise `supabase/migrations/0004_request_rate_limit.sql` against a
 * DISPOSABLE Postgres, then throw the database away.
 *
 * WHY THIS EXISTS
 *   The migration's whole claim is atomicity under concurrency, and that claim
 *   cannot be tested in JavaScript. It also cannot be tested on the shared
 *   project without writing to it. So this script starts a throwaway container,
 *   creates the Supabase roles the migration's `revoke`/`grant` statements name,
 *   applies the real file twice (proving it is re-runnable), checks object
 *   shape, privileges and behaviour, and finally points twelve separate sessions
 *   at the same bucket at the same instant to prove the last slot can be taken
 *   once and only once.
 *
 * WHAT IT DOES NOT DO
 *   It never reads project credentials, never contacts Supabase, and never
 *   applies anything to a shared database. The only thing it proves about
 *   production is that this exact SQL behaves as intended on Postgres 16 — a
 *   separate, operator-approved step is still required to apply it there.
 *
 * Requires Docker. Usage: pnpm verify:rate-limit-sql
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTAINER = `horizon-rate-limit-verify-${process.pid}`;
const MIGRATION = join(process.cwd(), "supabase", "migrations", "0004_request_rate_limit.sql");

let failures = 0;

function check(label: string, passed: boolean, detail = ""): void {
  if (passed) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.slice(0, 3).join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/** One psql invocation. Several of these in flight at once are several sessions. */
function psql(sql: string): string {
  return docker(
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    sql,
  ).trim();
}

/** A statement expected to be REJECTED, returning the error text. */
function psqlExpectingFailure(sql: string): string {
  const result = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-f", "-"],
    { input: sql, encoding: "utf8" },
  );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function waitForPostgres(): void {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], {
      encoding: "utf8",
    });
    if (ready.status === 0) return;
    spawnSync("sleep", ["0.5"]);
  }
  throw new Error("the disposable Postgres did not become ready");
}

async function main(): Promise<void> {
  const sql = readFileSync(MIGRATION, "utf8");

  console.log(`Starting disposable Postgres (${CONTAINER})…`);
  docker([
    "run",
    "--rm",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    "POSTGRES_PASSWORD=verify-only",
    "postgres:16-alpine",
  ]);
  waitForPostgres();

  // The migration names the three Supabase roles. A bare Postgres does not have
  // them, so they are created here; without this the revokes would error and the
  // test would be measuring the harness rather than the migration.
  psql(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
  `);

  console.log("\n1. Apply 0004 to an empty database");
  psql(sql);
  check("the migration applies cleanly", true);
  psql(sql);
  check("re-applying it is a no-op (re-runnable)", true);

  console.log("\n2. Object shape");
  check(
    "the table exists",
    psql("select to_regclass('public.request_rate_limits') is not null;") === "t",
  );
  check(
    "the primary key is (bucket_key, window_seconds, window_start)",
    psql(`
      select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum))
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
      where i.indrelid = 'public.request_rate_limits'::regclass and i.indisprimary;
    `) === "bucket_key,window_seconds,window_start",
  );
  check(
    "window_start is indexed for pruning",
    psql(`
      select count(*) from pg_indexes
      where schemaname = 'public' and tablename = 'request_rate_limits'
        and indexdef ilike '%(window_start)%';
    `) !== "0",
  );
  check(
    "counts cannot go negative and windows cannot be zero",
    psql(`
      select count(*) = 2 from pg_constraint
      where conrelid = 'public.request_rate_limits'::regclass and contype = 'c';
    `) === "t",
  );
  check(
    "RLS is enabled",
    psql(`
      select relrowsecurity from pg_class where oid = 'public.request_rate_limits'::regclass;
    `) === "t",
  );
  check(
    "no policy grants a client access to the table",
    psql("select count(*) from pg_policies where tablename = 'request_rate_limits';") === "0",
  );

  console.log("\n3. Function properties");
  const functionRow = psql(`
    select prosecdef, coalesce(array_to_string(proconfig, '|'), ''), pronargs
    from pg_proc where oid = 'public.horizon_admit_request(text,integer,integer,timestamptz)'::regprocedure;
  `);
  const [securityDefiner, searchPath, arity] = functionRow.split("|");
  check("it is SECURITY DEFINER", securityDefiner === "t");
  check("the search_path is pinned to public, pg_temp", searchPath === "search_path=public, pg_temp");
  check("it takes four arguments", arity === "4", functionRow);
  check(
    "service_role can execute it",
    psql(`
      select has_function_privilege('service_role',
        'public.horizon_admit_request(text,integer,integer,timestamptz)', 'execute');
    `) === "t",
  );
  check(
    "anon cannot execute it",
    psql(`
      select has_function_privilege('anon',
        'public.horizon_admit_request(text,integer,integer,timestamptz)', 'execute');
    `) === "f",
  );
  check(
    "service_role can claim a slot through the SECURITY DEFINER function",
    // `set role` prints its own status line, so the answer is the last line.
    psql(
      "set role service_role;\n" +
        "select admitted from public.horizon_admit_request('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 600, 1, '2026-10-19T09:00:00Z');",
    ).split("\n").pop() === "t",
  );
  check(
    "a client role is refused at the table AND at the function",
    /permission denied/i.test(
      psqlExpectingFailure(`
        set role anon;
        select count(*) from public.request_rate_limits;
      `),
    ) &&
      /permission denied/i.test(
        psqlExpectingFailure(`
          set role anon;
          select * from public.horizon_admit_request('aaaabbbbccccdddd', 600, 2, now());
        `),
      ),
  );

  console.log("\n4. Behaviour: the limit binds and the window rolls over");
  // The app sends 64 hex characters (HMAC-SHA256). Using the same shape here means
  // the final "nothing address-shaped is stored" check measures the schema, not
  // this script's fixtures.
  const bucket = "0123456789abcdef".repeat(4);
  const sequence = [1, 2, 3].map(() =>
    psql(`
      select admitted, used, remaining, retry_after_seconds
      from public.horizon_admit_request('${bucket}', 600, 2, '2026-10-19T09:00:00Z');
    `)
      .split("\n")
      .map((line) => line.split("|")),
  );
  check(
    "the first two calls are admitted and the third is not",
    sequence.map(([row]) => row?.[0]).join(",") === "t,t,f",
    JSON.stringify(sequence),
  );
  check(
    "the refusal reports the window's remaining seconds",
    Number(sequence[2]?.[0]?.[3] ?? 0) > 0 && Number(sequence[2]?.[0]?.[3] ?? 0) <= 600,
    JSON.stringify(sequence[2]),
  );
  check(
    "the refused call did not increment the counter",
    psql(`
      select request_count from public.request_rate_limits
      where bucket_key = '${bucket}' and window_seconds = 600;
    `) === "2",
  );
  check(
    "the same bucket is admitted again after the window rolls over",
    psql(`
      select admitted from public.horizon_admit_request('${bucket}', 600, 2, '2026-10-19T09:10:00Z');
    `) === "t",
  );
  check(
    "a non-positive limit refuses instead of meaning 'no limit'",
    psql(`
      select admitted from public.horizon_admit_request('${bucket}', 600, 0, '2026-10-19T09:10:00Z');
    `) === "f",
  );
  check(
    "a key that is not hash-shaped is rejected, not counted",
    /invalid bucket key/i.test(
      psqlExpectingFailure(`
        select * from public.horizon_admit_request('short', 600, 2, now());
      `),
    ),
  );

  console.log("\n5. Concurrency: twelve sessions, one last slot");
  const limit = 4;
  const concurrentBucket = "fedcba9876543210".repeat(4);
  const startAt = new Date(Date.now() + 2500).toISOString();
  // Every session sleeps until the same wall-clock instant, so they contend on
  // the row rather than drifting in as psql starts up.
  const session = `
    select pg_sleep(greatest(0, extract(epoch from (timestamptz '${startAt}' - clock_timestamp()))));
    select admitted from public.horizon_admit_request(
      '${concurrentBucket}', 600, ${limit}, '2026-10-19T09:00:00Z'
    );
  `;
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, () =>
      new Promise<string>((resolve) => {
        const child = spawn("docker", [
          "exec",
          "-i",
          CONTAINER,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-tA",
          "-v",
          "ON_ERROR_STOP=1",
          "-f",
          "-",
        ]);
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.on("close", () => resolve(output.trim().split("\n").pop()?.trim() ?? ""));
        child.stdin.end(session);
      }),
    ),
  );
  const admitted = outcomes.filter((outcome) => outcome === "t").length;
  console.log(`    outcomes: ${outcomes.join(",")}`);
  check(`exactly ${limit} of 12 concurrent requests were admitted`, admitted === limit, `got ${admitted}`);
  check(
    "the stored count equals the number admitted (no lost update, no overshoot)",
    psql(`
      select request_count from public.request_rate_limits
      where bucket_key = '${concurrentBucket}' and window_seconds = 600;
    `) === String(limit),
  );

  console.log("\n6. What is stored");
  check(
    "every stored key is a 64-hex hash and no address is stored",
    psql(`
      select count(*) = 0 from public.request_rate_limits
      where bucket_key !~ '^[0-9a-f]{64}$';
    `) === "t",
  );
  check(
    "no column can hold an address, a question or a user id",
    psql(`
      select string_agg(column_name, ',' order by ordinal_position)
      from information_schema.columns
      where table_schema = 'public' and table_name = 'request_rate_limits';
    `) === "bucket_key,window_seconds,window_start,request_count",
  );

  console.log("\n7. Rollback rehearsal");
  psql(`
    drop function if exists public.horizon_admit_request(text, integer, integer, timestamptz);
    drop table if exists public.request_rate_limits;
  `);
  check(
    "the table and function are gone",
    psql(`
      select (to_regclass('public.request_rate_limits') is null)
         and (to_regprocedure('public.horizon_admit_request(text,integer,integer,timestamptz)') is null);
    `) === "t",
  );
  check(
    "the function is gone rather than replaced by an open one (the app fails closed)",
    /does not exist/i.test(
      psqlExpectingFailure(`
        select * from public.horizon_admit_request('aaaabbbbccccdddd', 600, 2, now());
      `),
    ),
  );

  console.log(
    failures === 0
      ? `\nRESULT: PASS — ${MIGRATION} verified on disposable Postgres 16`
      : `\nRESULT: FAIL — ${failures} check(s) failed`,
  );
}

main()
  .catch((error: unknown) => {
    failures += 1;
    console.error(`\nRESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    process.exit(failures === 0 ? 0 : 1);
  });
