import type { ProjectGraphQueryKind } from "@solidity-workbench/common";

export type ProjectGraphRelationshipIndexingMode = "auto" | "manual" | "disabled";

export function shouldDrainRelationshipsForGraphQuery(
  kind: ProjectGraphQueryKind,
  relationshipIndexing: ProjectGraphRelationshipIndexingMode,
): boolean {
  if (relationshipIndexing === "disabled") return false;
  return kind === "callers" || kind === "impact";
}
