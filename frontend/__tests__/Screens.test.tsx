import React from 'react';
import { ActivityIndicator, TextInput } from 'react-native';
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
  AnalyzingOverlay,
  ChatScreen,
  DocumentsScreen,
  HomeScreen,
  InsightsScreen,
  ReportScreen,
  palettes,
  type ChatMessage,
} from '../src/App';
import {
  findPressableByLabel,
  findPressableWithText,
  getAllText,
  makeInsightResponse,
  sampleDocuments,
  sampleQueryResponse,
} from './testUtils';

const colors = palettes.dark;

describe('App Screen Components', () => {
  describe('AnalyzingOverlay', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('renders progress, analysis steps, status metadata, and triggers onDismiss', async () => {
      const onDismiss = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <AnalyzingOverlay
            document={sampleDocuments[1]}
            colors={colors}
            darkMode={true}
            onDismiss={onDismiss}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Analyzing DRHP');
      expect(texts).toContain('Acme_Tech_DRHP.pdf');
      expect(texts).toContain('Analyzing · Extracting prospectus');
      expect(texts).toContain('Analyzing Acme Tech DRHP');
      expect(texts).toContain('Reading document');
      expect(texts).toContain('Generating final analysis');

      const closeBtn = findPressableByLabel(renderer, 'Close analysis progress');
      await ReactTestRenderer.act(() => {
        closeBtn.props.onPress();
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);

      await ReactTestRenderer.act(() => {
        renderer.unmount();
      });
    });

    test('shows 100% completion and ready status when document becomes ready', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <AnalyzingOverlay
            document={sampleDocuments[0]}
            colors={palettes.light}
            darkMode={false}
            onDismiss={jest.fn()}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Completed · Ready to explore');
      expect(texts).toContain('100%');

      await ReactTestRenderer.act(() => {
        renderer.unmount();
      });
    });
  });

  describe('HomeScreen', () => {
    test('renders empty state, header actions, upload card, and routes feature tiles to onViewAll when no ready doc exists', async () => {
      const onUpload = jest.fn();
      const onViewAll = jest.fn();
      const onToggleTheme = jest.fn();
      const onNotifications = jest.fn();
      const onSignOut = jest.fn();

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <HomeScreen
            documents={[]}
            colors={colors}
            darkMode={true}
            loading={false}
            notice="Upload queued"
            error="Network warning"
            onUpload={onUpload}
            onOpenDocument={jest.fn()}
            onDeleteDocument={jest.fn()}
            onViewAll={onViewAll}
            onToggleTheme={onToggleTheme}
            onNotifications={onNotifications}
            onSignOut={onSignOut}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Analyze DRHPs with AI');
      expect(texts).toContain('Upload DRHP (PDF)');
      expect(texts).toContain('Upload queued');
      expect(texts).toContain('Network warning');
      expect(texts).toContain('Your research starts here');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Upload DRHP (PDF)').props.onPress();
        findPressableWithText(renderer, 'Financials').props.onPress();
        findPressableByLabel(renderer, 'Notifications').props.onPress();
        findPressableByLabel(renderer, 'Sign out').props.onPress();
        findPressableByLabel(renderer, 'Switch to light mode').props.onPress();
      });

      expect(onUpload).toHaveBeenCalledTimes(1);
      expect(onViewAll).toHaveBeenCalledTimes(1);
      expect(onNotifications).toHaveBeenCalledTimes(1);
      expect(onSignOut).toHaveBeenCalledTimes(1);
      expect(onToggleTheme).toHaveBeenCalledTimes(1);
    });

    test('opens ready document in matching report tab from feature tiles and shows up to 3 recent docs with delete action', async () => {
      const onOpenDocument = jest.fn();
      const onDeleteDocument = jest.fn();

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <HomeScreen
            documents={sampleDocuments}
            colors={colors}
            darkMode={true}
            loading={true}
            onUpload={jest.fn()}
            onOpenDocument={onOpenDocument}
            onDeleteDocument={onDeleteDocument}
            onViewAll={jest.fn()}
            onToggleTheme={jest.fn()}
            onNotifications={jest.fn()}
            onSignOut={jest.fn()}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Uploading…');
      // Only first 3 documents shown in recent list
      expect(texts).toContain('Lenskart-Solutions-DRHP.pdf');
      expect(texts).toContain('Acme_Tech_DRHP.pdf');
      expect(texts).toContain('Queued_Filing.pdf');
      expect(texts).not.toContain('Scanned_Copy.pdf');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Company Summary').props.onPress();
        findPressableWithText(renderer, 'Financials').props.onPress();
        findPressableWithText(renderer, 'Key Risks').props.onPress();
        findPressableWithText(renderer, 'IPO Details').props.onPress();
      });

      expect(onOpenDocument).toHaveBeenNthCalledWith(1, sampleDocuments[0], 'Overview');
      expect(onOpenDocument).toHaveBeenNthCalledWith(2, sampleDocuments[0], 'Financials');
      expect(onOpenDocument).toHaveBeenNthCalledWith(3, sampleDocuments[0], 'Risks');
      expect(onOpenDocument).toHaveBeenNthCalledWith(4, sampleDocuments[0], 'IPO');

      await ReactTestRenderer.act(() => {
        findPressableByLabel(
          renderer,
          'Delete Lenskart-Solutions-DRHP.pdf',
        ).props.onPress();
      });
      expect(onDeleteDocument).toHaveBeenCalledWith(sampleDocuments[0]);
    });
  });

  describe('DocumentsScreen', () => {
    test('renders empty state when there are no documents and triggers upload', async () => {
      const onUpload = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <DocumentsScreen
            documents={[]}
            colors={colors}
            loading={false}
            error="Could not load library"
            onOpenDocument={jest.fn()}
            onUpload={onUpload}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('My documents');
      expect(texts).toContain('No documents yet');
      expect(texts).toContain('Could not load library');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Upload a DRHP').props.onPress();
      });
      expect(onUpload).toHaveBeenCalledTimes(1);
    });

    test('renders all documents and opens selected document on press', async () => {
      const onOpenDocument = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <DocumentsScreen
            documents={sampleDocuments}
            colors={colors}
            loading={false}
            onOpenDocument={onOpenDocument}
            onUpload={jest.fn()}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Scanned_Copy.pdf');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Acme_Tech_DRHP.pdf').props.onPress();
      });
      expect(onOpenDocument).toHaveBeenCalledWith(sampleDocuments[1]);
    });
  });

  describe('ReportScreen', () => {
    test('renders structured insight view, switches report tabs, and handles back, refresh, and ask actions', async () => {
      const setReportTab = jest.fn();
      const onBack = jest.fn();
      const onAsk = jest.fn();
      const onRefresh = jest.fn().mockResolvedValue(undefined);

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <ReportScreen
            document={sampleDocuments[0]}
            reportTab="Overview"
            setReportTab={setReportTab}
            insight={makeInsightResponse('overview')}
            loading={false}
            colors={colors}
            onBack={onBack}
            onAsk={onAsk}
            onRefresh={onRefresh}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Lenskart-Solutions-DRHP.pdf');
      expect(texts).toContain('Company overview');
      expect(texts).toContain('Lenskart Solutions Limited');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Financials').props.onPress();
        findPressableWithText(renderer, '‹').props.onPress();
        findPressableWithText(renderer, 'Ask AI about this DRHP').props.onPress();
        findPressableByLabel(renderer, 'Refresh document status').props.onPress();
      });

      expect(setReportTab).toHaveBeenCalledWith('Financials');
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(onAsk).toHaveBeenCalledTimes(1);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    test('renders loading, error with retry, and non-ready document states', async () => {
      const onRefresh = jest.fn().mockResolvedValue(undefined);

      let loadingRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        loadingRenderer = ReactTestRenderer.create(
          <ReportScreen
            document={sampleDocuments[0]}
            reportTab="Financials"
            setReportTab={jest.fn()}
            loading={true}
            colors={colors}
            onBack={jest.fn()}
            onAsk={jest.fn()}
            onRefresh={onRefresh}
          />,
        );
      });
      expect(loadingRenderer.root.findAllByType(ActivityIndicator)).toHaveLength(1);
      expect(getAllText(loadingRenderer)).toContain('Financial highlights');

      let errorRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        errorRenderer = ReactTestRenderer.create(
          <ReportScreen
            document={sampleDocuments[0]}
            reportTab="Risks"
            setReportTab={jest.fn()}
            loading={false}
            error="Failed to load insights"
            colors={colors}
            onBack={jest.fn()}
            onAsk={jest.fn()}
            onRefresh={onRefresh}
          />,
        );
      });
      expect(getAllText(errorRenderer)).toContain('Failed to load insights');
      await ReactTestRenderer.act(() => {
        findPressableWithText(errorRenderer, 'Retry').props.onPress();
      });
      expect(onRefresh).toHaveBeenCalledTimes(1);

      let failedDocRenderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        failedDocRenderer = ReactTestRenderer.create(
          <ReportScreen
            document={sampleDocuments[3]}
            reportTab="IPO"
            setReportTab={jest.fn()}
            loading={false}
            colors={colors}
            onBack={jest.fn()}
            onAsk={jest.fn()}
            onRefresh={onRefresh}
          />,
        );
      });
      const failedTexts = getAllText(failedDocRenderer);
      expect(failedTexts).toContain('IPO details');
      expect(failedTexts).toContain('Analysis couldn’t be completed');
      expect(failedTexts).toContain('Document requires OCR before indexing.');
    });
  });

  describe('ChatScreen', () => {
    test('renders empty state when no document is selected and allows selecting a document pill', async () => {
      const onSelectDocument = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <ChatScreen
            documents={sampleDocuments}
            selectedDocumentId={undefined}
            messages={[]}
            question=""
            loading={false}
            colors={colors}
            keyboardVisible={false}
            onSelectDocument={onSelectDocument}
            onQuestionChange={jest.fn()}
            onSend={jest.fn()}
            onFeedback={jest.fn()}
            onOpenDocument={jest.fn()}
          />,
        );
      });

      expect(getAllText(renderer)).toContain('Choose a document');
      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Lenskart-Solutions-DRHP.pdf').props.onPress();
      });
      expect(onSelectDocument).toHaveBeenCalledWith(sampleDocuments[0].documentId);
    });

    test('renders welcome card, suggested prompts, composer, and report details link when selected', async () => {
      const onSend = jest.fn();
      const onQuestionChange = jest.fn();
      const onOpenDocument = jest.fn();

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <ChatScreen
            documents={sampleDocuments}
            selectedDocumentId={sampleDocuments[0].documentId}
            messages={[]}
            question="What is the revenue?"
            loading={false}
            colors={colors}
            keyboardVisible={false}
            onSelectDocument={jest.fn()}
            onQuestionChange={onQuestionChange}
            onSend={onSend}
            onFeedback={jest.fn()}
            onOpenDocument={onOpenDocument}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Ask anything about this DRHP');
      expect(texts).toContain('Show financials');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Report details ›').props.onPress();
        findPressableWithText(renderer, 'Show financials').props.onPress();
        renderer.root.findByType(TextInput).props.onChangeText('New question');
        findPressableByLabel(renderer, 'Send question').props.onPress();
      });

      expect(onOpenDocument).toHaveBeenCalledWith(sampleDocuments[0]);
      expect(onSend).toHaveBeenNthCalledWith(1, 'Show financials');
      expect(onQuestionChange).toHaveBeenCalledWith('New question');
      expect(onSend).toHaveBeenNthCalledWith(2);
    });

    test('renders chat messages with feedback controls, error retry card, and loading state', async () => {
      const onFeedback = jest.fn();
      const onSend = jest.fn();
      const messages: ChatMessage[] = [
        {
          id: 'm1',
          documentId: sampleDocuments[0].documentId,
          question: 'What was FY25 revenue?',
          response: sampleQueryResponse,
        },
        {
          id: 'm2',
          documentId: sampleDocuments[0].documentId,
          question: 'List subsidiaries',
          error: 'Query timed out',
        },
      ];

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <ChatScreen
            documents={sampleDocuments}
            selectedDocumentId={sampleDocuments[0].documentId}
            messages={messages}
            question=""
            loading={true}
            colors={colors}
            keyboardVisible={true}
            onSelectDocument={jest.fn()}
            onQuestionChange={jest.fn()}
            onSend={onSend}
            onFeedback={onFeedback}
            onOpenDocument={jest.fn()}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('What was FY25 revenue?');
      expect(texts).toContain(sampleQueryResponse.answer);
      expect(texts).toContain('Query timed out');
      expect(texts).toContain('Searching the prospectus…');
      // Suggested prompts hidden when keyboard is visible
      expect(texts).not.toContain('Show financials');

      await ReactTestRenderer.act(() => {
        findPressableByLabel(renderer, 'Mark answer helpful').props.onPress();
        findPressableByLabel(renderer, 'Mark answer not helpful').props.onPress();
        findPressableWithText(renderer, 'Retry').props.onPress();
      });

      expect(onFeedback).toHaveBeenCalledWith('m1', 'helpful');
      expect(onFeedback).toHaveBeenCalledWith('m1', 'not_helpful');
      expect(onSend).toHaveBeenCalledWith('List subsidiaries', 'm2');
    });
  });

  describe('InsightsScreen', () => {
    test('computes workspace summary counts and opens documents from latest analyses', async () => {
      const onOpenDocument = jest.fn();
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <InsightsScreen
            documents={sampleDocuments}
            colors={colors}
            onOpenDocument={onOpenDocument}
          />,
        );
      });

      const texts = getAllText(renderer);
      expect(texts).toContain('Insights');
      expect(texts).toContain('4'); // total
      expect(texts).toContain('2'); // queued + processing
      expect(texts).toContain('Documents');
      expect(texts).toContain('Analyzed');
      expect(texts).toContain('In progress');
      expect(texts).toContain('Needs attention');

      await ReactTestRenderer.act(() => {
        findPressableWithText(renderer, 'Lenskart-Solutions-DRHP.pdf').props.onPress();
      });
      expect(onOpenDocument).toHaveBeenCalledWith(sampleDocuments[0]);
    });

    test('renders empty state when workspace has no documents', async () => {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(
          <InsightsScreen
            documents={[]}
            colors={colors}
            onOpenDocument={jest.fn()}
          />,
        );
      });

      expect(getAllText(renderer)).toContain('No insights yet');
    });
  });
});
