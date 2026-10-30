// The deployment's administrators: `ADMINS`, a list of user Durable Object names.

/**
 * True when `name` (a user Durable Object's name) is listed in `ADMINS`. With a principal resolver
 * bound, a principal's name is `principal:<id>`, or the email of the existing user it is an alias
 * of (see principal-aliases.ts).
 */
export function isAdminUserName(env: { ADMINS?: string[] | string }, name: string | undefined): boolean {
  let admins = env.ADMINS;

  if (!name || !admins) return false;

  if (typeof admins === "string") {
    // Admins should be a JSON binding of array type, but `.env` doesn't actually let you
    // specify JSON bindings, so we also support a string that parses as JSON array.
    admins = JSON.parse(admins);
  }

  if (!Array.isArray(admins)) {
    throw new TypeError("ADMINS must be configured as an array of usernames.");
  }

  return admins.includes(name);
}
