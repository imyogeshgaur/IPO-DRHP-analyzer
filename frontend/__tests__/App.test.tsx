/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
jest.mock('react-native-svg', () => {
  const MockSvg = 'Svg';
  return {
    __esModule: true,
    default: MockSvg,
    Svg: MockSvg,
    Circle: 'Circle',
    Defs: 'Defs',
    G: 'G',
    Line: 'Line',
    LinearGradient: 'LinearGradient',
    Path: 'Path',
    Rect: 'Rect',
    Stop: 'Stop',
    Text: 'SvgText',
  };
});
jest.mock('@react-native-documents/picker', () => ({
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
  isErrorWithCode: () => false,
  pick: jest.fn(),
  types: { pdf: 'application/pdf' },
}));
jest.mock('../src/auth', () => ({
  confirmAdditionalSignInStep: jest.fn(),
  confirmEmailSignUp: jest.fn(),
  finishPasswordReset: jest.fn(),
  getAccessToken: async () => undefined,
  isCognitoConfigured: false,
  sendPasswordReset: jest.fn(),
  signInWithEmail: jest.fn(),
  signOutUser: jest.fn(),
  signUpWithEmail: jest.fn(),
}));
import App from '../App';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
