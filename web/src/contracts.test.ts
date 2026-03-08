import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("generated contracts", () => {
  it("no longer exports legacy FolderPayload types", () => {
    const generatedContracts = readFileSync(
      resolve(import.meta.dirname, "generated/tmv-contract.ts"),
      "utf8"
    );
    const publicTypes = readFileSync(resolve(import.meta.dirname, "types.ts"), "utf8");

    expect(generatedContracts).not.toContain("export type FolderPayload");
    expect(publicTypes).not.toContain("FolderPayload");
    expect(generatedContracts).toContain("export type RootSummaryPayload");
    expect(generatedContracts).toContain("export type CategoryPagePayload");
  });
});
