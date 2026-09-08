export interface InfrastructureGuardResult {
  allowed: boolean;
  reason: string;
}

export function evaluateInfrastructureGuard(
  environment: string,
  operation: string,
  confirmation?: string,
): InfrastructureGuardResult;
