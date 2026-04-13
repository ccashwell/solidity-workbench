import * as vscode from "vscode";

/**
 * Extension configuration accessor.
 * Wraps vscode.workspace.getConfiguration for type-safe access.
 */
export interface SolforgeConfig {
  foundryPath: string;
  formatOnSave: boolean;
  diagnostics: {
    compileOnSave: boolean;
    debounceMs: number;
  };
  slither: {
    enabled: boolean;
    path: string;
  };
  inlayHints: {
    parameterNames: boolean;
    variableTypes: boolean;
  };
  gasEstimates: {
    enabled: boolean;
  };
  test: {
    verbosity: number;
  };
}

export function getConfig(): SolforgeConfig {
  const config = vscode.workspace.getConfiguration("solforge");

  return {
    foundryPath: config.get<string>("foundryPath") || "forge",
    formatOnSave: config.get<boolean>("formatOnSave") ?? true,
    diagnostics: {
      compileOnSave: config.get<boolean>("diagnostics.compileOnSave") ?? true,
      debounceMs: config.get<number>("diagnostics.debounceMs") ?? 500,
    },
    slither: {
      enabled: config.get<boolean>("slither.enabled") ?? false,
      path: config.get<string>("slither.path") || "slither",
    },
    inlayHints: {
      parameterNames: config.get<boolean>("inlayHints.parameterNames") ?? true,
      variableTypes: config.get<boolean>("inlayHints.variableTypes") ?? false,
    },
    gasEstimates: {
      enabled: config.get<boolean>("gasEstimates.enabled") ?? true,
    },
    test: {
      verbosity: config.get<number>("test.verbosity") ?? 2,
    },
  };
}
