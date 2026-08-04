import { loadOidcConfig, OidcService } from "./oidc-service.ts";

let service: OidcService | undefined;

export function getOidcService(): OidcService {
  service ??= new OidcService({ config: loadOidcConfig(process.env) });
  return service;
}
