/**
 * Typed representation of foundry.toml configuration.
 * Only the fields relevant to IDE tooling.
 */

export interface FoundryConfig {
  profile: Record<string, FoundryProfile>;
}

export interface FoundryProfile {
  /** Source directory (default: "src") */
  src?: string;
  /** Test directory (default: "test") */
  test?: string;
  /** Script directory (default: "script") */
  script?: string;
  /** Output directory (default: "out") */
  out?: string;
  /** Library directories (default: ["lib"]) */
  libs?: string[];
  /** Import remappings */
  remappings?: string[];
  /** Solc version (optional, forge auto-detects) */
  solc_version?: string;
  /** EVM version */
  evm_version?: string;
  /** Optimizer settings */
  optimizer?: boolean;
  optimizer_runs?: number;
  /** Via IR compilation */
  via_ir?: boolean;
  /** Formatter settings */
  fmt?: FoundryFmtConfig;
}

export interface FoundryFmtConfig {
  line_length?: number;
  tab_width?: number;
  bracket_spacing?: boolean;
  int_types?: "long" | "short" | "preserve";
  multiline_func_header?: "attributes_first" | "params_first" | "all";
  quote_style?: "double" | "single";
  number_underscore?: "preserve" | "thousands" | "remove";
  single_line_statement_blocks?: "preserve" | "single" | "multi";
  sort_imports?: boolean;
}

/**
 * Remapping entry parsed from foundry.toml or remappings.txt
 * Format: context:prefix=path
 */
export interface Remapping {
  context?: string;
  prefix: string;
  path: string;
}

export function parseRemapping(raw: string): Remapping {
  const contextSplit = raw.indexOf(":");
  let rest = raw;
  let context: string | undefined;

  if (contextSplit !== -1 && raw.indexOf("=") > contextSplit) {
    context = raw.slice(0, contextSplit);
    rest = raw.slice(contextSplit + 1);
  }

  const eqIndex = rest.indexOf("=");
  if (eqIndex === -1) {
    return { prefix: rest, path: rest };
  }

  return {
    context,
    prefix: rest.slice(0, eqIndex),
    path: rest.slice(eqIndex + 1),
  };
}

export function resolveImportPath(importPath: string, remappings: Remapping[]): string | null {
  for (const r of remappings) {
    if (importPath.startsWith(r.prefix)) {
      return r.path + importPath.slice(r.prefix.length);
    }
  }
  return null;
}
