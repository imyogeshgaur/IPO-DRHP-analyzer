/**
 * @format
 */

import React from 'react';
import { TextInput } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const SafeAreaInsetsContext = ReactActual.createContext(insets);
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(
        SafeAreaInsetsContext.Provider,
        { value: insets },
        children,
      ),
    SafeAreaView: View,
    SafeAreaInsetsContext,
  };
});
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
  getAccessToken: jest.fn(async () => undefined),
  isCognitoConfigured: false,
  sendPasswordReset: jest.fn(),
  signInWithEmail: jest.fn(),
  signOutUser: jest.fn(async () => undefined),
  signUpWithEmail: jest.fn(),
}));
jest.mock('../src/api', () => ({
  askDocument: jest.fn(),
  deleteDocument: jest.fn(),
  getDocumentInsight: jest.fn(),
  listDocuments: jest.fn(),
  refreshDocumentInsight: jest.fn(),
  submitFeedback: jest.fn(),
  uploadDrhp: jest.fn(),
}));

import App from '../App';
import * as api from '../src/api';
import {
  findPressableByLabel,
  findPressableWithText,
  getAllText,
  makeInsightResponse,
  sampleDocuments,
  sampleQueryResponse,
} from './testUtils';

const mockedApi = api as jest.Mocked<typeof api>;

describe('App root component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApi.listDocuments.mockResolvedValue([sampleDocuments[0]]);
    mockedApi.getDocumentInsight.mockResolvedValue(makeInsightResponse('overview'));
    mockedApi.askDocument.mockResolvedValue(sampleQueryResponse);
  });

  test('renders sign-in screen by default and toggles light/dark theme', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<App />);
    });

    const texts = getAllText(renderer);
    expect(texts).toContain('Sunivesh');
    expect(texts).toContain('Welcome back');
    expect(texts).toContain('Continue in local preview');

    const themeBtn = findPressableByLabel(renderer, 'Switch to light mode');
    await ReactTestRenderer.act(() => {
      themeBtn.props.onPress();
    });
    expect(findPressableByLabel(renderer, 'Switch to dark mode')).toBeTruthy();
  });

  test('switches between sign-up and forgot-password flows and validates terms checkbox', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<App />);
    });

    // Navigate to Sign up via link text
    await ReactTestRenderer.act(() => {
      findPressableWithText(renderer, /^Sign up$/).props.onPress();
    });
    expect(getAllText(renderer)).toContain('Create your account');

    // Attempt to create account without accepting terms
    await ReactTestRenderer.act(() => {
      findPressableWithText(renderer, 'Create account').props.onPress();
    });
    expect(getAllText(renderer)).toContain(
      'Please accept the Terms and Privacy Policy to continue.',
    );

    // Return to Sign in, then open Forgot password
    await ReactTestRenderer.act(() => {
      findPressableWithText(renderer, /^Sign in$/).props.onPress();
    });
    await ReactTestRenderer.act(() => {
      findPressableWithText(renderer, 'Forgot password?').props.onPress();
    });
    expect(getAllText(renderer)).toContain('Reset your password');
  });

  test('authenticates in local preview, loads documents, opens report, asks chat question, and signs out', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<App />);
    });

    await ReactTestRenderer.act(async () => {
      findPressableWithText(renderer, 'Continue in local preview').props.onPress();
    });

    expect(mockedApi.listDocuments).toHaveBeenCalledTimes(1);
    expect(getAllText(renderer)).toContain('Analyze DRHPs with AI');
    expect(getAllText(renderer)).toContain('Lenskart-Solutions-DRHP.pdf');

    // Open ready document -> ReportScreen fetches overview insight
    await ReactTestRenderer.act(async () => {
      findPressableWithText(renderer, 'Lenskart-Solutions-DRHP.pdf').props.onPress();
    });

    expect(mockedApi.getDocumentInsight).toHaveBeenCalledWith(
      sampleDocuments[0].documentId,
      'overview',
    );
    expect(getAllText(renderer)).toContain('Lenskart Solutions Limited');

    // Jump to Chat screen and ask a question
    await ReactTestRenderer.act(async () => {
      findPressableWithText(renderer, 'Ask AI about this DRHP').props.onPress();
    });
    expect(getAllText(renderer)).toContain('Ask AI');

    await ReactTestRenderer.act(async () => {
      renderer.root.findByType(TextInput).props.onChangeText('What was FY25 revenue?');
    });
    await ReactTestRenderer.act(async () => {
      findPressableByLabel(renderer, 'Send question').props.onPress();
    });

    expect(mockedApi.askDocument).toHaveBeenCalledWith(
      sampleDocuments[0].documentId,
      'What was FY25 revenue?',
    );
    expect(getAllText(renderer)).toContain(sampleQueryResponse.answer);

    // Return to Home tab via BottomNavigation and sign out
    await ReactTestRenderer.act(async () => {
      findPressableWithText(renderer, 'Home').props.onPress();
    });
    // Back out of ReportScreen to HomeScreen
    await ReactTestRenderer.act(async () => {
      findPressableWithText(renderer, '‹').props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      findPressableByLabel(renderer, 'Sign out').props.onPress();
    });
    expect(getAllText(renderer)).toContain('Welcome back');
  });
});
