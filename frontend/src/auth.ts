import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import "@aws-amplify/react-native";
import { Amplify } from "aws-amplify";
import {
  confirmResetPassword,
  confirmSignIn,
  confirmSignUp,
  fetchAuthSession,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from "aws-amplify/auth";
import { cognitoConfig } from "./config";

if (cognitoConfig) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cognitoConfig.userPoolId,
        userPoolClientId: cognitoConfig.userPoolClientId,
        loginWith: { email: true },
      },
    },
  });
}

export const isCognitoConfigured = Boolean(cognitoConfig);

export async function getAccessToken(): Promise<string | undefined> {
  if (!cognitoConfig) return undefined;
  const session = await fetchAuthSession();
  return session.tokens?.accessToken.toString();
}

export async function signInWithEmail(
  email: string,
  password: string,
): Promise<{ isSignedIn: boolean; nextStep: string }> {
  const result = await signIn({ username: email, password });
  return {
    isSignedIn: result.isSignedIn,
    nextStep: result.nextStep.signInStep,
  };
}

export async function signUpWithEmail(
  name: string,
  email: string,
  password: string,
): Promise<boolean> {
  const result = await signUp({
    username: email,
    password,
    options: { userAttributes: { email, name } },
  });
  return result.isSignUpComplete;
}

export async function confirmEmailSignUp(
  email: string,
  confirmationCode: string,
): Promise<boolean> {
  const result = await confirmSignUp({ username: email, confirmationCode });
  return result.isSignUpComplete;
}

export async function sendPasswordReset(email: string): Promise<void> {
  await resetPassword({ username: email });
}

export async function finishPasswordReset(
  email: string,
  confirmationCode: string,
  newPassword: string,
): Promise<void> {
  await confirmResetPassword({
    username: email,
    confirmationCode,
    newPassword,
  });
}

export async function confirmAdditionalSignInStep(code: string): Promise<void> {
  await confirmSignIn({ challengeResponse: code });
}

export async function signOutUser(): Promise<void> {
  if (cognitoConfig) await signOut();
}
