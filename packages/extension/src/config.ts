import * as vscode from "vscode";

/**
 * Extension configuration accessor.
 * Wraps vscode.workspace.getConfiguration for type-safe access.
 */
export interface WorkbenchConfig {
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
  };
  gasEstimates: {
    enabled: boolean;
  };
  projectGraph: {
    relationshipIndexing: "auto" | "manual" | "disabled";
    dependencyIndexing: "disabled" | "declarations" | "relationships";
  };
  test: {
    verbosity: number;
  };
  mutation: {
    maxMutants: number;
    timeoutMs: number;
    includeTests: boolean;
  };
}

export function getConfig(): WorkbenchConfig {
  const config = vscode.workspace.getConfiguration("solidity-workbench");

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
    },
    gasEstimates: {
      enabled: config.get<boolean>("gasEstimates.enabled") ?? true,
    },
    projectGraph: {
      relationshipIndexing: graphRelationshipIndexingMode(
        config.get<string>("projectGraph.relationshipIndexing"),
      ),
      dependencyIndexing: graphDependencyIndexingMode(
        config.get<string>("projectGraph.dependencyIndexing"),
      ),
    },
    test: {
      verbosity: config.get<number>("test.verbosity") ?? 2,
    },
    mutation: {
      maxMutants: config.get<number>("mutation.maxMutants") ?? 25,
      timeoutMs: config.get<number>("mutation.timeoutMs") ?? 120_000,
      includeTests: config.get<boolean>("mutation.includeTests") ?? false,
    },
  };
}

function graphRelationshipIndexingMode(value: string | undefined): "auto" | "manual" | "disabled" {
  return value === "manual" || value === "disabled" ? value : "auto";
}

function graphDependencyIndexingMode(
  value: string | undefined,
): "disabled" | "declarations" | "relationships" {
  return value === "declarations" || value === "relationships" ? value : "disabled";
}

// Forge CLI helpers live in `@solidity-workbench/common/foundry-cli`
// so the server's `node --test` runner can exercise them.
export { forgeVerbosityFlag } from "@solidity-workbench/common";
