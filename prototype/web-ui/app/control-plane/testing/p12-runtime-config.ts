export function usesP12ContractAdapters(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const configured = environment.HARNESS_P12_CONTRACT_ADAPTERS?.trim();
  if (!configured || configured === "disabled") return false;
  if (configured !== "enabled") {
    throw new Error(
      "HARNESS_P12_CONTRACT_ADAPTERS must be enabled or disabled",
    );
  }
  if (environment.NODE_ENV === "production") {
    throw new Error("P12 contract adapters are forbidden in production");
  }
  if (environment.WORKBENCH_DATA_SOURCE !== "postgres" ||
    !environment.DATABASE_URL?.trim()) {
    throw new Error(
      "P12 contract adapters require an isolated PostgreSQL runtime",
    );
  }
  return true;
}
