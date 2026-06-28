function splitConfiguredTokens(rawValue) {
  return String(rawValue ?? "")
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getConfiguredApiTokens(env = process.env) {
  return [...new Set(splitConfiguredTokens(env.FLOW_API_TOKENS))];
}

export function isApiAuthEnabled(env = process.env) {
  return getConfiguredApiTokens(env).length > 0;
}

export function extractBearerToken(value) {
  const match = String(value ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function isAuthorizedBearerToken(value, env = process.env) {
  const tokens = getConfiguredApiTokens(env);

  if (tokens.length === 0) {
    return true;
  }

  const providedToken = extractBearerToken(value);
  return tokens.includes(providedToken);
}
