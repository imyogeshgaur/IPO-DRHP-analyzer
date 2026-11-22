import {
  API_BASE_URL as configuredApiBaseUrl,
  COGNITO_CLIENT_ID,
  COGNITO_REGION,
  COGNITO_USER_POOL_ID,
  UPLOAD_MODE,
} from "@env";

export const apiBaseUrl = (
  configuredApiBaseUrl || "http://localhost:3000/api/v1"
).replace(/\/+$/, "");

export const uploadMode = UPLOAD_MODE || "local";
if (uploadMode !== "local" && uploadMode !== "s3") {
  throw new Error('UPLOAD_MODE must be either "local" or "s3".');
}

export const cognitoConfig =
  COGNITO_REGION && COGNITO_USER_POOL_ID && COGNITO_CLIENT_ID
    ? {
        region: COGNITO_REGION,
        userPoolId: COGNITO_USER_POOL_ID,
        userPoolClientId: COGNITO_CLIENT_ID,
      }
    : undefined;

if (
  cognitoConfig &&
  !cognitoConfig.userPoolId.startsWith(`${cognitoConfig.region}_`)
) {
  throw new Error("COGNITO_REGION does not match COGNITO_USER_POOL_ID.");
}
