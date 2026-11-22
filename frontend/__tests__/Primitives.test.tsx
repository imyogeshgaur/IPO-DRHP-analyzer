import React from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  View,
} from 'react-native';
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

import {
  AnswerCard,
  BottomNavigation,
  DocumentRow,
  EmptyState,
  FeatureTile,
  Field,
  KeyboardAwareContainer,
  Logo,
  PrimaryButton,
  StatCard,
  StatusDot,
  ThemeToggle,
  palettes,
} from '../src/App';
import {
  findPressableByLabel,
  findPressableWithText,
  getAllText,
  sampleDocuments,
  sampleQueryResponse,
} from './testUtils';

const colors = palettes.dark;

describe('App UI Primitive Components', () => {
  describe('Logo', () => {
    test('renders Sunivesh wordmark and logo image with accessibility label', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<Logo small colors={colors} />);
      });

      const image = renderer.root.findByType(Image);
      expect(image.props.accessibilityLabel).toBe('Sunivesh logo');
      expect(getAllText(renderer)).toContain('Sunivesh');
    });
  });

  describe('ThemeToggle', () => {
    test('shows correct accessibility label and glyph for dark and light modes and fires onPress', async () => {
      const onPress = jest.fn();
      let darkRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        darkRenderer = ReactTestRenderer.create(
          <ThemeToggle darkMode={true} colors={colors} onPress={onPress} />,
        );
      });

      const darkBtn = findPressableByLabel(darkRenderer, 'Switch to light mode');
      expect(getAllText(darkRenderer)).toContain('☼');

      await ReactTestRenderer.act(() => {
        darkBtn.props.onPress();
      });
      expect(onPress).toHaveBeenCalledTimes(1);

      let lightRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        lightRenderer = ReactTestRenderer.create(
          <ThemeToggle
            darkMode={false}
            colors={palettes.light}
            onPress={onPress}
          />,
        );
      });
      expect(
        findPressableByLabel(lightRenderer, 'Switch to dark mode'),
      ).toBeTruthy();
      expect(getAllText(lightRenderer)).toContain('☾');
    });
  });

  describe('PrimaryButton', () => {
    test('renders title and triggers onPress when idle, and shows spinner when loading', async () => {
      const onPress = jest.fn();
      let idleRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        idleRenderer = ReactTestRenderer.create(
          <PrimaryButton title="Sign in" onPress={onPress} colors={colors} />,
        );
      });

      expect(getAllText(idleRenderer)).toContain('Sign in');
      const btn = findPressableWithText(idleRenderer, 'Sign in');
      expect(btn.props.disabled).toBe(false);
      await ReactTestRenderer.act(() => {
        btn.props.onPress();
      });
      expect(onPress).toHaveBeenCalledTimes(1);

      let loadingRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        loadingRenderer = ReactTestRenderer.create(
          <PrimaryButton
            title="Sign in"
            loading={true}
            onPress={onPress}
            colors={colors}
          />,
        );
      });
      const disabledButtons = loadingRenderer.root.findAll(
        (node) =>
          typeof node.props.onPress === 'function' &&
          node.props.disabled === true,
      );
      expect(disabledButtons.length).toBeGreaterThan(0);
      expect(loadingRenderer.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    });
  });

  describe('Field', () => {
    test('renders label, forwards TextInput props, and invokes right action callback', async () => {
      const onChangeText = jest.fn();
      const onRightPress = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <Field
            label="Password"
            placeholder="At least 8 characters"
            value="secret123"
            onChangeText={onChangeText}
            secureTextEntry={true}
            rightLabel="Show"
            onRightPress={onRightPress}
            colors={colors}
          />,
        );
      });

      expect(getAllText(renderer)).toContain('Password');
      expect(getAllText(renderer)).toContain('Show');

      const input = renderer.root.findByType(TextInput);
      expect(input.props.value).toBe('secret123');
      expect(input.props.secureTextEntry).toBe(true);
      await ReactTestRenderer.act(() => {
        input.props.onChangeText('updated');
      });
      expect(onChangeText).toHaveBeenCalledWith('updated');

      const showBtn = findPressableWithText(renderer, 'Show');
      await ReactTestRenderer.act(() => {
        showBtn.props.onPress();
      });
      expect(onRightPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('EmptyState', () => {
    test('renders title and description', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <EmptyState
            title="No documents yet"
            description="Upload a DRHP PDF to begin."
            colors={colors}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('No documents yet');
      expect(texts).toContain('Upload a DRHP PDF to begin.');
    });
  });

  describe('StatCard', () => {
    test('renders numeric value and label', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <StatCard label="Analyzed" value={7} colors={colors} />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('7');
      expect(texts).toContain('Analyzed');
    });
  });

  describe('FeatureTile', () => {
    test('renders glyph, title, subtitle, and triggers onPress', async () => {
      const onPress = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <FeatureTile
            glyph="▥"
            title="Financials"
            subtitle="Revenue & trends"
            colors={colors}
            onPress={onPress}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('▥');
      expect(texts).toContain('Financials');
      expect(texts).toContain('Revenue & trends');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Financials').props.onPress();
      });
      expect(onPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('StatusDot', () => {
    test('maps document status to green, red, and blue dot colors', async () => {
      const cases = [
        { status: 'ready' as const, expected: colors.green },
        { status: 'failed' as const, expected: colors.red },
        { status: 'processing' as const, expected: colors.blue },
        { status: 'queued' as const, expected: colors.blue },
      ];

      for (const item of cases) {
        let renderer!: ReactTestRenderer.ReactTestRenderer;
        await ReactTestRenderer.act(() => {
          renderer = ReactTestRenderer.create(
            <StatusDot status={item.status} colors={colors} />,
          );
        });
        const dot = renderer.root.findByType(View);
        expect(dot.props.style).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ backgroundColor: item.expected }),
          ]),
        );
      }
    });
  });

  describe('DocumentRow', () => {
    test('renders document details, handles press, and renders optional delete button', async () => {
      const onPress = jest.fn();
      const onDelete = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <DocumentRow
            document={sampleDocuments[0]}
            colors={colors}
            onPress={onPress}
            onDelete={onDelete}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Lenskart-Solutions-DRHP.pdf');
      expect(texts).toContain('Analyzed');
      expect(texts).toContain('Delete');

      const rowBtn = findPressableWithText(renderer, 'Lenskart-Solutions-DRHP.pdf');
      await ReactTestRenderer.act(() => {
        rowBtn.props.onPress();
      });
      expect(onPress).toHaveBeenCalledTimes(1);

      const deleteBtn = findPressableByLabel(
        renderer,
        'Delete Lenskart-Solutions-DRHP.pdf',
      );
      await ReactTestRenderer.act(() => {
        deleteBtn.props.onPress();
      });
      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    test('renders failure error message and deleting spinner state', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <DocumentRow
            document={sampleDocuments[3]}
            colors={colors}
            onPress={jest.fn()}
            onDelete={jest.fn()}
            deleting={true}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Analysis failed');
      expect(texts).toContain('Document requires OCR before indexing.');
      expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(1);
      const deleteBtn = findPressableByLabel(
        renderer,
        'Delete Scanned_Copy.pdf',
      );
      expect(deleteBtn.props.disabled).toBe(true);
    });
  });

  describe('AnswerCard', () => {
    test('renders answer text and citations with page numbers or fallback labels', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <AnswerCard response={sampleQueryResponse} colors={colors} />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain(sampleQueryResponse.answer);
      expect(texts).toContain('Sources');
      expect(texts).toContain('Page 42');
      expect(texts).toContain('DRHP source');
    });

    test('renders empty-citations notice when no sources are returned', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <AnswerCard
            response={{
              ...sampleQueryResponse,
              citations: [],
            }}
            colors={colors}
            embedded={true}
          />,
        );
      });

      expect(getAllText(renderer)).toContain(
        'No source pages were returned for this answer.',
      );
    });
  });

  describe('BottomNavigation', () => {
    test('renders all four tabs and calls setActiveTab when pressed', async () => {
      const setActiveTab = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <BottomNavigation
            activeTab="home"
            setActiveTab={setActiveTab}
            colors={colors}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toEqual(
        expect.arrayContaining(['Home', 'My Docs', 'Chat', 'Insights']),
      );

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Chat').props.onPress();
      });
      expect(setActiveTab).toHaveBeenCalledWith('chat');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Insights').props.onPress();
      });
      expect(setActiveTab).toHaveBeenCalledWith('insights');
    });
  });

  describe('KeyboardAwareContainer', () => {
    const originalOs = Platform.OS;

    afterEach(() => {
      Platform.OS = originalOs;
    });

    test('renders KeyboardAvoidingView on iOS', async () => {
      Platform.OS = 'ios';
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <KeyboardAwareContainer>
            <Text>iOS Child</Text>
          </KeyboardAwareContainer>,
        );
      });

      expect(renderer.root.findAllByType(KeyboardAvoidingView)).toHaveLength(1);
      expect(getAllText(renderer)).toContain('iOS Child');
    });

    test('adjusts paddingBottom via keyboard events on Android', async () => {
      Platform.OS = 'android';
      const listeners: Record<string, (event?: unknown) => void> = {};
      const addListenerSpy = jest
        .spyOn(Keyboard, 'addListener')
        .mockImplementation((eventName, cb) => {
          listeners[eventName] = cb as (event?: unknown) => void;
          return { remove: jest.fn() } as never;
        });

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <KeyboardAwareContainer>
            <Text>Android Child</Text>
          </KeyboardAwareContainer>,
        );
      });

      const containerView = renderer.root.findByType(View);
      expect(containerView.props.style).toEqual(
        expect.arrayContaining([expect.objectContaining({ paddingBottom: 0 })]),
      );

      await ReactTestRenderer.act(() => {
        listeners.keyboardDidShow?.({ endCoordinates: { height: 280 } });
      });
      expect(renderer.root.findByType(View).props.style).toEqual(
        expect.arrayContaining([expect.objectContaining({ paddingBottom: 280 })]),
      );

      await ReactTestRenderer.act(() => {
        listeners.keyboardDidHide?.();
      });
      expect(renderer.root.findByType(View).props.style).toEqual(
        expect.arrayContaining([expect.objectContaining({ paddingBottom: 0 })]),
      );

      addListenerSpy.mockRestore();
    });
  });
});
