/** Copy of `env` without the given keys / key prefixes. Use it so secrets in the
 *  parent environment (dev shells!) never reach a child that shouldn't see them. */
export function withoutEnv(
  env: NodeJS.ProcessEnv,
  { keys = [], prefixes = [] }: { keys?: string[]; prefixes?: string[] },
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (keys.includes(key) || prefixes.some((p) => key.startsWith(p))) delete out[key];
  }
  return out;
}
