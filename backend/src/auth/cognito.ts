import { CognitoJwtVerifier } from "aws-jwt-verify";

export type AccessTokenAuthenticator = (accessToken: string) => Promise<string>;

export function createCognitoAuthenticator(
  userPoolId: string,
  clientId: string,
): AccessTokenAuthenticator {
  const verifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: "access",
    clientId,
  });

  return async (accessToken) => {
    const payload = await verifier.verify(accessToken);
    if (!payload.sub) {
      throw new Error("Cognito access token has no subject");
    }
    return payload.sub;
  };
}
