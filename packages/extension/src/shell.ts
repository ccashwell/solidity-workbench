/**
 * Quote a single shell argument for VS Code terminal commands.
 *
 * Terminal-backed commands are still shell strings, so every path, configured
 * binary, RPC URL, or user-provided value must be escaped before interpolation.
 */
export function shellArg(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(args: string[]): string {
  return args.map(shellArg).join(" ");
}
