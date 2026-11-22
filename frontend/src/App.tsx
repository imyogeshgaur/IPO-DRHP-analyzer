import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  errorCodes,
  isErrorWithCode,
  pick,
  types,
} from "@react-native-documents/picker";
import {
  SafeAreaInsetsContext,
  SafeAreaView,
} from "react-native-safe-area-context";
import {
  askDocument,
  deleteDocument as deleteDocumentFromApi,
  getDocumentInsight,
  listDocuments,
  refreshDocumentInsight,
  submitFeedback,
  uploadDrhp,
} from "./api";
import {
  confirmAdditionalSignInStep,
  confirmEmailSignUp,
  finishPasswordReset,
  getAccessToken,
  isCognitoConfigured,
  sendPasswordReset,
  signInWithEmail,
  signOutUser,
  signUpWithEmail,
} from "./auth";
import { ReportInsightView } from "./components/ReportVisuals";
import type {
  DocumentInsightResponse,
  DocumentRecord,
  InsightSection,
  QueryResponse,
} from "./types";

type AuthStage =
  | "signIn"
  | "signUp"
  | "confirmSignUp"
  | "challenge"
  | "forgotPassword"
  | "confirmPasswordReset";
type AppTab = "home" | "documents" | "chat" | "insights";
type ReportTab = "Overview" | "Financials" | "Risks" | "IPO";
type ChatMessage = {
  id: string;
  documentId: string;
  question: string;
  response?: QueryResponse;
  error?: string;
  feedbackRating?: "helpful" | "not_helpful";
  feedbackError?: string;
};

const reportTabToSection: Record<ReportTab, InsightSection> = {
  Overview: "overview",
  Financials: "financials",
  Risks: "risks",
  IPO: "ipo",
};

const analysisSteps = [
  "Reading document",
  "Extracting and structuring content",
  "Analyzing company insights",
  "Processing financials and ratios",
  "Generating final analysis",
] as const;

const suggestedQuestions = [
  "Show financials",
  "IPO details",
  "What are the key risks?",
  "Growth plans",
];

type Palette = {
  background: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  secondary: string;
  muted: string;
  border: string;
  blue: string;
  blueSoft: string;
  green: string;
  red: string;
  input: string;
};

const palettes: Record<"dark" | "light", Palette> = {
  dark: {
    background: "#071126",
    surface: "#0D1A35",
    surfaceRaised: "#122242",
    text: "#F4F7FF",
    secondary: "#B7C3DD",
    muted: "#8190B0",
    border: "#243657",
    blue: "#2185FF",
    blueSoft: "#132F5A",
    green: "#38D69A",
    red: "#FF777B",
    input: "#101E3B",
  },
  light: {
    background: "#F4F7FD",
    surface: "#FFFFFF",
    surfaceRaised: "#F8FAFF",
    text: "#101D3A",
    secondary: "#52627F",
    muted: "#7C8AA5",
    border: "#DCE4F3",
    blue: "#0869F7",
    blueSoft: "#E8F1FF",
    green: "#128D68",
    red: "#CF4F56",
    input: "#FFFFFF",
  },
};

function KeyboardAwareContainer({
  children,
}: {
  children: React.ReactNode;
}) {
  const insets = React.useContext(SafeAreaInsetsContext) ?? {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };
  const [keyboardHeight, setKeyboardHeight] = useState(() =>
    Platform.OS === "android" ? (Keyboard.metrics?.()?.height ?? 0) : 0,
  );
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const showSub = Keyboard.addListener("keyboardDidShow", (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  if (Platform.OS === "ios") {
    return (
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        {children}
      </KeyboardAvoidingView>
    );
  }

  let androidBottomInset = 0;
  if (keyboardHeight > 0) {
    const screenHeight = Dimensions.get("screen").height;
    const fullAvailableHeight = Math.max(
      0,
      screenHeight - insets.top - insets.bottom,
    );
    const windowShrink =
      containerHeight > 0 && fullAvailableHeight > 0
        ? Math.max(0, fullAvailableHeight - containerHeight)
        : 0;
    androidBottomInset = Math.max(0, keyboardHeight - windowShrink);
  }

  return (
    <View
      style={[styles.fill, { paddingBottom: androidBottomInset }]}
      onLayout={(event) => {
        setContainerHeight(event.nativeEvent.layout.height);
      }}
    >
      {children}
    </View>
  );
}

const appLogo = require("./assets/app-logo.png");

function Logo({
  small = false,
  colors,
}: {
  small?: boolean;
  colors?: Palette;
}) {
  return (
    <View style={styles.logoLockup}>
      <Image
        source={appLogo}
        accessibilityLabel="Sunivesh logo"
        style={[styles.logoImage, small && styles.logoImageSmall]}
      />
      <Text
        style={[
          styles.logoName,
          small && styles.logoNameSmall,
          colors ? { color: colors.text } : undefined,
        ]}
      >
        Sunivesh
      </Text>
    </View>
  );
}

function App() {
  const [darkMode, setDarkMode] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authStage, setAuthStage] = useState<AuthStage>("signIn");
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [reportTab, setReportTab] = useState<ReportTab>("Overview");
  const [reportInsight, setReportInsight] = useState<DocumentInsightResponse>();
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string>();
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [question, setQuestion] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [feedbackLoadingId, setFeedbackLoadingId] = useState<string>();
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [analyzingDocumentId, setAnalyzingDocumentId] = useState<string>();
  const [dismissedAnalyzingIds, setDismissedAnalyzingIds] = useState<string[]>(
    [],
  );
  const [actionLoading, setActionLoading] = useState(false);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const colors = palettes[darkMode ? "dark" : "light"];
  const queryCacheRef = useRef<Map<string, QueryResponse>>(new Map());
  const inFlightQueriesRef = useRef<Map<string, Promise<QueryResponse>>>(
    new Map(),
  );
  const insightCacheRef = useRef<Map<string, DocumentInsightResponse>>(
    new Map(),
  );
  const inFlightInsightsRef = useRef<
    Map<string, Promise<DocumentInsightResponse>>
  >(new Map());
  const selectedDocument = documents.find(
    (document) => document.documentId === selectedDocumentId,
  );

  const fetchDocumentInsightOnce = useCallback(
    (
      documentId: string,
      section: InsightSection,
      updatedAt?: string,
      forceRefresh = false,
    ): Promise<DocumentInsightResponse> => {
      const key = `${documentId}::${updatedAt ?? ""}::${section}`;
      if (!forceRefresh) {
        const cached = insightCacheRef.current.get(key);
        if (cached) {
          return Promise.resolve(cached);
        }
        const inFlight = inFlightInsightsRef.current.get(key);
        if (inFlight) {
          return inFlight;
        }
      }
      const pending = (
        forceRefresh
          ? refreshDocumentInsight(documentId, section)
          : getDocumentInsight(documentId, section)
      )
        .then((response) => {
          insightCacheRef.current.set(key, response);
          return response;
        })
        .finally(() => {
          inFlightInsightsRef.current.delete(key);
        });
      inFlightInsightsRef.current.set(key, pending);
      return pending;
    },
    [],
  );

  const askDocumentOnce = useCallback(
    (
      documentId: string,
      prompt: string,
      updatedAt?: string,
    ): Promise<QueryResponse> => {
      const key = queryCacheKey(documentId, updatedAt, prompt);
      const cached = queryCacheRef.current.get(key);
      if (cached) {
        return Promise.resolve(cached);
      }
      const inFlight = inFlightQueriesRef.current.get(key);
      if (inFlight) {
        return inFlight;
      }
      const pending = askDocument(documentId, prompt)
        .then((response) => {
          queryCacheRef.current.set(key, response);
          return response;
        })
        .finally(() => {
          inFlightQueriesRef.current.delete(key);
        });
      inFlightQueriesRef.current.set(key, pending);
      return pending;
    },
    [],
  );

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, () =>
      setKeyboardVisible(true),
    );
    const hideSubscription = Keyboard.addListener(hideEvent, () =>
      setKeyboardVisible(false),
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const refreshDocuments = useCallback(
    async (options?: { manual?: boolean; silent?: boolean }) => {
      if (options?.manual) {
        setManualRefreshing(true);
      } else if (!options?.silent) {
        setDocumentsLoading(true);
      }
      try {
        setDocuments(await listDocuments());
      } catch (error) {
        setErrorMessage(errorText(error));
      } finally {
        if (options?.manual) {
          setManualRefreshing(false);
        } else if (!options?.silent) {
          setDocumentsLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    getAccessToken()
      .then((token) => {
        if (active && token) setIsAuthenticated(true);
      })
      .catch((error: unknown) => {
        if (active) setErrorMessage(errorText(error));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated) refreshDocuments();
  }, [isAuthenticated, refreshDocuments]);

  useEffect(() => {
    if (
      !isAuthenticated ||
      !documents.some(
        (document) =>
          document.status === "queued" || document.status === "processing",
      )
    ) {
      return;
    }
    const timer = setInterval(
      () => refreshDocuments({ silent: true }),
      4000,
    );
    return () => clearInterval(timer);
  }, [documents, isAuthenticated, refreshDocuments]);

  const activeAnalyzingDocument = useMemo(() => {
    if (analyzingDocumentId) {
      const explicit = documents.find(
        (document) => document.documentId === analyzingDocumentId,
      );
      if (explicit) return explicit;
    }
    return documents.find(
      (document) =>
        (document.status === "queued" || document.status === "processing") &&
        !dismissedAnalyzingIds.includes(document.documentId),
    );
  }, [analyzingDocumentId, dismissedAnalyzingIds, documents]);

  useEffect(() => {
    if (!activeAnalyzingDocument) return;
    if (
      activeAnalyzingDocument.status === "queued" ||
      activeAnalyzingDocument.status === "processing"
    ) {
      if (analyzingDocumentId !== activeAnalyzingDocument.documentId) {
        setAnalyzingDocumentId(activeAnalyzingDocument.documentId);
      }
      return;
    }
    if (activeAnalyzingDocument.status === "ready") {
      const timer = setTimeout(() => {
        setAnalyzingDocumentId(undefined);
        setNotice(`${activeAnalyzingDocument.filename} is ready to explore.`);
      }, 750);
      return () => clearTimeout(timer);
    }
    if (activeAnalyzingDocument.status === "failed") {
      setAnalyzingDocumentId(undefined);
      if (activeAnalyzingDocument.error?.message) {
        setErrorMessage(activeAnalyzingDocument.error.message);
      }
    }
  }, [activeAnalyzingDocument, analyzingDocumentId]);

  useEffect(() => {
    if (
      activeTab !== "home" ||
      !selectedDocumentId ||
      selectedDocument?.status !== "ready"
    ) {
      setReportInsight(undefined);
      setReportError(undefined);
      return;
    }

    const section = reportTabToSection[reportTab];
    const cacheKey = `${selectedDocumentId}::${selectedDocument?.updatedAt ?? ""}::${section}`;
    const cached = insightCacheRef.current.get(cacheKey);
    if (cached) {
      setReportInsight(cached);
      setReportError(undefined);
      setReportLoading(false);
      return;
    }

    let active = true;
    setReportInsight(undefined);
    setReportError(undefined);
    setReportLoading(true);
    fetchDocumentInsightOnce(
      selectedDocumentId,
      section,
      selectedDocument?.updatedAt,
    )
      .then((response) => {
        if (active) setReportInsight(response);
      })
      .catch((error: unknown) => {
        if (active) setReportError(errorText(error));
      })
      .finally(() => {
        if (active) setReportLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    activeTab,
    fetchDocumentInsightOnce,
    reportTab,
    selectedDocument?.status,
    selectedDocument?.updatedAt,
    selectedDocumentId,
  ]);

  const handleRefreshReport = useCallback(async () => {
    if (!selectedDocument || selectedDocument.status !== "ready") {
      await refreshDocuments();
      return;
    }
    const section = reportTabToSection[reportTab];
    setReportError(undefined);
    setReportLoading(true);
    try {
      const fresh = await fetchDocumentInsightOnce(
        selectedDocument.documentId,
        section,
        selectedDocument.updatedAt,
        true,
      );
      setReportInsight(fresh);
    } catch (error) {
      setReportError(errorText(error));
    } finally {
      setReportLoading(false);
    }
  }, [fetchDocumentInsightOnce, refreshDocuments, reportTab, selectedDocument]);

  const openDocument = (document: DocumentRecord, tab: ReportTab = "Overview") => {
    if (document.status === "queued" || document.status === "processing") {
      setDismissedAnalyzingIds((current) =>
        current.filter((id) => id !== document.documentId),
      );
      setAnalyzingDocumentId(document.documentId);
      return;
    }
    setSelectedDocumentId(document.documentId);
    setReportTab(tab);
    setActiveTab("home");
    setChatMessages([]);
    setReportInsight(undefined);
    setReportError(undefined);
  };

  const handleUpload = async () => {
    setErrorMessage(undefined);
    setNotice(undefined);
    try {
      const [file] = await pick({ type: [types.pdf] });
      if (!file?.uri) throw new Error("The selected PDF could not be opened.");
      setActionLoading(true);
      await uploadDrhp({
        uri: file.uri,
        name: file.name || "prospectus.pdf",
        type: file.type || "application/pdf",
      });
      setDismissedAnalyzingIds([]);
      setNotice("DRHP uploaded. Analysis will appear here when it is ready.");
      await refreshDocuments({ silent: true });
    } catch (error) {
      if (
        isErrorWithCode(error) &&
        error.code === errorCodes.OPERATION_CANCELED
      ) {
        return;
      }
      setErrorMessage(errorText(error));
    } finally {
      setActionLoading(false);
    }
  };

  const deleteDocumentFromLibrary = async (document: DocumentRecord) => {
    setErrorMessage(undefined);
    setNotice(undefined);
    setDeletingDocumentId(document.documentId);
    try {
      await deleteDocumentFromApi(document.documentId);
      setDocuments((current) =>
        current.filter((item) => item.documentId !== document.documentId),
      );
      setChatMessages((current) =>
        current.filter((message) => message.documentId !== document.documentId),
      );
      clearDocumentCache(queryCacheRef.current, document.documentId);
      clearDocumentCache(inFlightQueriesRef.current, document.documentId);
      clearDocumentCache(insightCacheRef.current, document.documentId);
      clearDocumentCache(inFlightInsightsRef.current, document.documentId);
      if (selectedDocumentId === document.documentId) {
        setSelectedDocumentId(undefined);
        setReportInsight(undefined);
      }
      setNotice(`${document.filename} and its analysis were deleted.`);
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setDeletingDocumentId(undefined);
    }
  };

  const confirmDeleteDocument = (document: DocumentRecord) => {
    Alert.alert(
      "Delete this DRHP?",
      "This permanently deletes the uploaded PDF from S3 and removes its analysis, chunks, and feedback from MongoDB.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await deleteDocumentFromLibrary(document);
          },
        },
      ],
    );
  };

  const handleSendQuestion = async (value = question, retryMessageId?: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const documentId = selectedDocumentId ?? documents[0]?.documentId;
    if (!documentId) {
      setErrorMessage("Upload a DRHP before asking a question.");
      return;
    }
    const targetDocument = documents.find(
      (document) => document.documentId === documentId,
    );
    const cacheKey = queryCacheKey(
      documentId,
      targetDocument?.updatedAt,
      trimmed,
    );

    if (!retryMessageId) {
      if (inFlightQueriesRef.current.has(cacheKey)) {
        setQuestion("");
        return;
      }
      const cached = queryCacheRef.current.get(cacheKey);
      if (cached) {
        setQuestion("");
        setErrorMessage(undefined);
        const normalized = normalizeQuestion(trimmed);
        setChatMessages((current) => {
          const documentMessages = current.filter(
            (message) => message.documentId === documentId,
          );
          const lastMessage = documentMessages[documentMessages.length - 1];
          if (
            lastMessage &&
            lastMessage.response &&
            normalizeQuestion(lastMessage.question) === normalized
          ) {
            return current;
          }
          return [
            ...current,
            {
              id: `${Date.now()}`,
              documentId,
              question: trimmed,
              response: cached,
            },
          ];
        });
        return;
      }
    }

    if (!retryMessageId) setQuestion("");
    setChatLoading(true);
    setErrorMessage(undefined);
    const id = retryMessageId ?? `${Date.now()}`;
    setChatMessages((current) =>
      retryMessageId
        ? current.map((message) =>
            message.id === id
              ? { ...message, error: undefined, response: undefined }
              : message,
          )
        : [...current, { id, documentId, question: trimmed }],
    );
    try {
      const response = await askDocumentOnce(
        documentId,
        trimmed,
        targetDocument?.updatedAt,
      );
      setChatMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, response, error: undefined } : message,
        ),
      );
    } catch (error) {
      setChatMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, error: errorText(error) } : message,
        ),
      );
    } finally {
      setChatLoading(false);
    }
  };

  const handleFeedback = async (
    messageId: string,
    rating: "helpful" | "not_helpful",
  ) => {
    const message = chatMessages.find((item) => item.id === messageId);
    if (!message?.response || message.feedbackRating) return;
    setFeedbackLoadingId(messageId);
    try {
      await submitFeedback(message.documentId, message.question, rating);
      setChatMessages((current) =>
        current.map((item) =>
          item.id === messageId
            ? { ...item, feedbackRating: rating, feedbackError: undefined }
            : item,
        ),
      );
    } catch (error) {
      setChatMessages((current) =>
        current.map((item) =>
          item.id === messageId
            ? { ...item, feedbackError: errorText(error) }
            : item,
        ),
      );
    } finally {
      setFeedbackLoadingId(undefined);
    }
  };

  const authenticateLocally = () => {
    setErrorMessage(undefined);
    setIsAuthenticated(true);
  };

  const completeSignIn = () => {
    setErrorMessage(undefined);
    setIsAuthenticated(true);
  };

  const submitSignIn = async () => {
    setActionLoading(true);
    setErrorMessage(undefined);
    try {
      const result = await signInWithEmail(email.trim(), password);
      if (result.isSignedIn) {
        completeSignIn();
      } else {
        setAuthStage("challenge");
        setNotice(`Cognito requires an additional step: ${result.nextStep}`);
      }
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setActionLoading(false);
    }
  };

  const submitSignUp = async () => {
    if (!acceptedTerms) {
      setErrorMessage("Please accept the Terms and Privacy Policy to continue.");
      return;
    }
    setActionLoading(true);
    setErrorMessage(undefined);
    try {
      const complete = await signUpWithEmail(name.trim(), email.trim(), password);
      if (complete) {
        setAuthStage("signIn");
        setNotice("Your account is ready. Sign in to continue.");
      } else {
        setAuthStage("confirmSignUp");
        setNotice("Enter the confirmation code sent to your email.");
      }
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setActionLoading(false);
    }
  };

  const submitConfirmation = async () => {
    setActionLoading(true);
    setErrorMessage(undefined);
    try {
      await confirmEmailSignUp(email.trim(), confirmationCode.trim());
      setAuthStage("signIn");
      setNotice("Email confirmed. Sign in to continue.");
      setPassword("");
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setActionLoading(false);
    }
  };

  const submitAdditionalChallenge = async () => {
    setActionLoading(true);
    setErrorMessage(undefined);
    try {
      await confirmAdditionalSignInStep(confirmationCode.trim());
      completeSignIn();
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setActionLoading(false);
    }
  };

  const submitPasswordReset = async () => {
    setActionLoading(true);
    setErrorMessage(undefined);
    try {
      await sendPasswordReset(email.trim());
      setAuthStage("confirmPasswordReset");
      setNotice("Enter the password reset code sent to your email.");
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setActionLoading(false);
    }
  };

  const submitPasswordResetConfirmation = async () => {
    setActionLoading(true);
    setErrorMessage(undefined);
    try {
      await finishPasswordReset(
        email.trim(),
        confirmationCode.trim(),
        password,
      );
      setAuthStage("signIn");
      setPassword("");
      setNotice("Password updated. Sign in with your new password.");
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setActionLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOutUser();
      setIsAuthenticated(false);
      setDocuments([]);
      setSelectedDocumentId(undefined);
      setAnalyzingDocumentId(undefined);
      setDismissedAnalyzingIds([]);
      setChatMessages([]);
      queryCacheRef.current.clear();
      inFlightQueriesRef.current.clear();
      insightCacheRef.current.clear();
      inFlightInsightsRef.current.clear();
      setAuthStage("signIn");
    } catch (error) {
      setErrorMessage(errorText(error));
    }
  };

  if (!isAuthenticated) {
    return (
      <>
        <StatusBar
          barStyle={darkMode ? "light-content" : "dark-content"}
        />
        <SafeAreaView
          style={[styles.safeArea, { backgroundColor: colors.background }]}
        >
          <KeyboardAwareContainer>
            <ScrollView
              contentContainerStyle={styles.authScroll}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
              <View style={styles.authHeader}>
                <Logo colors={colors} />
                <ThemeToggle
                  darkMode={darkMode}
                  colors={colors}
                  onPress={() => setDarkMode((value) => !value)}
                />
              </View>
              <View style={styles.authIntro}>
                <Text style={[styles.heading, { color: colors.text }]}>
                  {authHeading(authStage)}
                </Text>
                <Text style={[styles.subtitle, { color: colors.secondary }]}>
                  {authSubtitle(authStage)}
                </Text>
              </View>

              {authStage === "signUp" && (
                <Field
                  label="Full name"
                  placeholder="Your name"
                  value={name}
                  onChangeText={setName}
                  colors={colors}
                  autoCapitalize="words"
                />
              )}
              {authStage !== "challenge" &&
                authStage !== "confirmSignUp" &&
                authStage !== "confirmPasswordReset" && (
                  <Field
                    label="Email"
                    placeholder="you@example.com"
                    value={email}
                    onChangeText={setEmail}
                    colors={colors}
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                )}
              {(authStage === "signIn" ||
                authStage === "signUp" ||
                authStage === "confirmPasswordReset") && (
                <Field
                  label={authStage === "confirmPasswordReset" ? "New password" : "Password"}
                  placeholder="At least 8 characters"
                  value={password}
                  onChangeText={setPassword}
                  colors={colors}
                  secureTextEntry={!showPassword}
                  rightLabel={showPassword ? "Hide" : "Show"}
                  onRightPress={() => setShowPassword((value) => !value)}
                />
              )}
              {(authStage === "confirmSignUp" ||
                authStage === "challenge" ||
                authStage === "confirmPasswordReset") && (
                <Field
                  label="Confirmation code"
                  placeholder="Enter the code from your email"
                  value={confirmationCode}
                  onChangeText={setConfirmationCode}
                  colors={colors}
                  keyboardType="number-pad"
                />
              )}
              {authStage === "signUp" && (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: acceptedTerms }}
                  onPress={() => setAcceptedTerms((value) => !value)}
                  style={styles.termsRow}
                >
                  <View
                    style={[
                      styles.checkbox,
                      {
                        backgroundColor: acceptedTerms
                          ? colors.blue
                          : colors.surface,
                        borderColor: acceptedTerms ? colors.blue : colors.border,
                      },
                    ]}
                  >
                    {acceptedTerms ? (
                      <Text style={styles.checkboxCheck}>✓</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.termsText, { color: colors.secondary }]}>
                    I agree to the{" "}
                    <Text style={{ color: colors.blue }}>Terms</Text> and{" "}
                    <Text style={{ color: colors.blue }}>Privacy Policy</Text>
                  </Text>
                </Pressable>
              )}

              {notice ? (
                <Text style={[styles.notice, { color: colors.blue }]}>
                  {notice}
                </Text>
              ) : null}
              {errorMessage ? (
                <Text style={[styles.error, { color: colors.red }]}>
                  {errorMessage}
                </Text>
              ) : null}

              <PrimaryButton
                title={authButtonLabel(authStage)}
                loading={actionLoading}
                onPress={() => {
                  if (authStage === "signIn") submitSignIn();
                  else if (authStage === "signUp") submitSignUp();
                  else if (authStage === "confirmSignUp") submitConfirmation();
                  else if (authStage === "challenge") submitAdditionalChallenge();
                  else if (authStage === "forgotPassword") submitPasswordReset();
                  else submitPasswordResetConfirmation();
                }}
                colors={colors}
              />

              {authStage === "signIn" && (
                <Pressable
                  onPress={() => {
                    setErrorMessage(undefined);
                    setNotice(undefined);
                    setAuthStage("forgotPassword");
                  }}
                  style={styles.forgotLink}
                >
                  <Text style={[styles.link, { color: colors.blue }]}>
                    Forgot password?
                  </Text>
                </Pressable>
              )}
              {authStage === "signIn" && !isCognitoConfigured && (
                <View style={styles.localPreview}>
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                  <Text style={[styles.orText, { color: colors.muted }]}>
                    or
                  </Text>
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                  <Pressable
                    onPress={authenticateLocally}
                    style={[styles.secondaryButton, { borderColor: colors.border }]}
                  >
                    <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
                      Continue in local preview
                    </Text>
                  </Pressable>
                </View>
              )}

              <View style={styles.authFooter}>
                {authStage === "signIn" ? (
                  <Text style={[styles.footerText, { color: colors.secondary }]}>
                    Don&apos;t have an account?{" "}
                    <Text
                      onPress={() => {
                        setErrorMessage(undefined);
                        setNotice(undefined);
                        setAcceptedTerms(false);
                        setAuthStage("signUp");
                      }}
                      style={[styles.link, { color: colors.blue }]}
                    >
                      Sign up
                    </Text>
                  </Text>
                ) : (
                  <Text style={[styles.footerText, { color: colors.secondary }]}>
                    Already have an account?{" "}
                    <Text
                      onPress={() => {
                        setErrorMessage(undefined);
                        setNotice(undefined);
                        setAuthStage("signIn");
                      }}
                      style={[styles.link, { color: colors.blue }]}
                    >
                      Sign in
                    </Text>
                  </Text>
                )}
              </View>
            </ScrollView>
          </KeyboardAwareContainer>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar
        barStyle={darkMode ? "light-content" : "dark-content"}
      />
      <SafeAreaView
        style={[styles.safeArea, { backgroundColor: colors.background }]}
      >
        <KeyboardAwareContainer>
          {selectedDocument && activeTab === "home" ? (
            <ReportScreen
              document={selectedDocument}
              reportTab={reportTab}
              setReportTab={setReportTab}
              insight={reportInsight}
              loading={reportLoading}
              error={reportError}
              colors={colors}
              onBack={() => setSelectedDocumentId(undefined)}
              onAsk={() => setActiveTab("chat")}
              onRefresh={handleRefreshReport}
            />
          ) : (
            <>
              {activeTab === "chat" ? (
                <ChatScreen
                  documents={documents}
                  selectedDocumentId={selectedDocumentId}
                  messages={chatMessages}
                  question={question}
                  loading={chatLoading}
                  error={errorMessage}
                  colors={colors}
                  keyboardVisible={keyboardVisible}
                  feedbackLoadingId={feedbackLoadingId}
                  onSelectDocument={setSelectedDocumentId}
                  onQuestionChange={setQuestion}
                  onSend={handleSendQuestion}
                  onFeedback={handleFeedback}
                  onOpenDocument={openDocument}
                />
              ) : (
                <ScrollView
                  key={activeTab}
                  contentContainerStyle={styles.mainScroll}
                  refreshControl={
                    <RefreshControl
                      refreshing={manualRefreshing}
                      onRefresh={() => refreshDocuments({ manual: true })}
                      tintColor={colors.blue}
                    />
                  }
                  keyboardShouldPersistTaps="handled"
                >
                  {activeTab === "home" && (
                    <HomeScreen
                      documents={documents}
                      colors={colors}
                      darkMode={darkMode}
                      loading={actionLoading}
                      notice={notice}
                      error={errorMessage}
                      onUpload={handleUpload}
                      onOpenDocument={openDocument}
                      onDeleteDocument={confirmDeleteDocument}
                      deletingDocumentId={deletingDocumentId}
                      onViewAll={() => setActiveTab("documents")}
                      onToggleTheme={() => setDarkMode((value) => !value)}
                      onNotifications={() =>
                        Alert.alert("Notifications", "You’re all caught up.")
                      }
                      onSignOut={handleSignOut}
                    />
                  )}
                  {activeTab === "documents" && (
                    <DocumentsScreen
                      documents={documents}
                      colors={colors}
                      loading={documentsLoading}
                      error={errorMessage}
                      onOpenDocument={openDocument}
                      onUpload={handleUpload}
                    />
                  )}
                  {activeTab === "insights" && (
                    <InsightsScreen
                      documents={documents}
                      colors={colors}
                      onOpenDocument={openDocument}
                    />
                  )}
                </ScrollView>
              )}
              {!keyboardVisible && (
                <BottomNavigation
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                  colors={colors}
                />
              )}
            </>
          )}
        </KeyboardAwareContainer>
        {activeAnalyzingDocument && (
          <AnalyzingOverlay
            document={activeAnalyzingDocument}
            colors={colors}
            darkMode={darkMode}
            onDismiss={() => {
              const id = activeAnalyzingDocument.documentId;
              setDismissedAnalyzingIds((current) =>
                current.includes(id) ? current : [...current, id],
              );
              setAnalyzingDocumentId(undefined);
            }}
          />
        )}
      </SafeAreaView>
    </>
  );
}

function AnalyzingOverlay({
  document,
  colors,
  darkMode,
  onDismiss,
}: {
  document: DocumentRecord;
  colors: Palette;
  darkMode: boolean;
  onDismiss: () => void;
}) {
  const insets = React.useContext(SafeAreaInsetsContext) ?? {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };
  const [progress, setProgress] = useState(() =>
    computeAnalysisProgress(document),
  );
  const pulseAnim = useRef(new Animated.Value(0.75)).current;

  useEffect(() => {
    setProgress(computeAnalysisProgress(document));
    if (document.status === "ready") return;
    const timer = setInterval(() => {
      setProgress(computeAnalysisProgress(document));
    }, 600);
    return () => clearInterval(timer);
  }, [document]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.55,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  const activeStepIndex =
    document.status === "ready"
      ? analysisSteps.length
      : document.status === "queued"
        ? 0
        : progress < 35
          ? 1
          : progress < 59
            ? 2
            : progress < 80
              ? 3
              : 4;

  const rightRotation = -135 + Math.min(progress, 50) * 3.6;
  const leftRotation = -135 + Math.max(0, progress - 50) * 3.6;
  const backdropColor = darkMode
    ? "rgba(7, 17, 38, 0.86)"
    : "rgba(244, 247, 253, 0.88)";
  const cardBackground = darkMode
    ? "rgba(13, 26, 53, 0.88)"
    : "rgba(255, 255, 255, 0.92)";
  const stepBackground = darkMode
    ? "rgba(13, 26, 53, 0.78)"
    : "rgba(255, 255, 255, 0.88)";
  const activeStepBackground = darkMode
    ? "rgba(33, 133, 255, 0.18)"
    : "rgba(8, 105, 247, 0.10)";
  const ringTrackColor = darkMode
    ? "rgba(56, 132, 255, 0.18)"
    : "rgba(8, 105, 247, 0.14)";
  const ringHaloColor = darkMode
    ? "rgba(33, 133, 255, 0.14)"
    : "rgba(8, 105, 247, 0.10)";

  return (
    <View
      style={[
        styles.analyzingBackdrop,
        {
          backgroundColor: backdropColor,
          paddingTop: insets.top + 10,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <View style={styles.analyzingHeader}>
        <Pressable
          accessibilityLabel="Close analysis progress"
          onPress={onDismiss}
          style={styles.analyzingBackButton}
        >
          <Text style={[styles.analyzingBackGlyph, { color: colors.text }]}>
            ←
          </Text>
        </Pressable>
        <Text style={[styles.analyzingHeaderTitle, { color: colors.text }]}>
          Analyzing DRHP
        </Text>
        <View style={styles.analyzingBackButton} />
      </View>

      <ScrollView
        contentContainerStyle={styles.analyzingContent}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={[
            styles.analyzingDocCard,
            {
              backgroundColor: cardBackground,
              borderColor: colors.border,
            },
          ]}
        >
          <View style={styles.analyzingPdfIcon}>
            <View style={styles.analyzingPdfCorner} />
            <Text style={styles.analyzingPdfLabel}>PDF</Text>
          </View>
          <View style={styles.flex}>
            <Text
              numberOfLines={1}
              style={[styles.analyzingDocName, { color: colors.text }]}
            >
              {document.filename}
            </Text>
            <Text
              style={[styles.analyzingDocMeta, { color: colors.secondary }]}
            >
              {document.status === "queued"
                ? "Queued · Preparing document"
                : document.status === "ready"
                  ? "Completed · Ready to explore"
                  : "Analyzing · Extracting prospectus"}
            </Text>
          </View>
        </View>

        <View style={styles.analyzingRingSection}>
          <View
            style={[
              styles.analyzingRingHalo,
              { backgroundColor: ringHaloColor },
            ]}
          />
          <View style={styles.analyzingRingWrap}>
            <View
              style={[
                styles.analyzingRingTrack,
                { borderColor: ringTrackColor },
              ]}
            />
            <View style={styles.analyzingHalfRight}>
              <View
                style={[
                  styles.analyzingCircleRight,
                  {
                    borderTopColor: colors.blue,
                    borderRightColor: colors.blue,
                    transform: [{ rotate: `${rightRotation}deg` }],
                  },
                ]}
              />
            </View>
            {progress > 50 && (
              <View style={styles.analyzingHalfLeft}>
                <View
                  style={[
                    styles.analyzingCircleLeft,
                    {
                      borderBottomColor: colors.blue,
                      borderLeftColor: colors.blue,
                      transform: [{ rotate: `${leftRotation}deg` }],
                    },
                  ]}
                />
              </View>
            )}
            <View style={styles.analyzingRingCenter}>
              <Animated.Text
                style={[
                  styles.analyzingSparkle,
                  { color: colors.text, opacity: pulseAnim },
                ]}
              >
                ✦
              </Animated.Text>
              <Text style={[styles.analyzingPercent, { color: colors.text }]}>
                {progress}%
              </Text>
            </View>
          </View>
        </View>

        <Text
          numberOfLines={2}
          style={[styles.analyzingTitle, { color: colors.text }]}
        >
          Analyzing {companyNameFromFile(document.filename)}
        </Text>
        <Text style={[styles.analyzingSubtitle, { color: colors.secondary }]}>
          Extracting key insights, financials, risks, and IPO details...
        </Text>

        <View style={styles.analyzingSteps}>
          {analysisSteps.map((step, index) => {
            const done = index < activeStepIndex;
            const active = index === activeStepIndex;
            return (
              <View
                key={step}
                style={[
                  styles.analyzingStepRow,
                  {
                    backgroundColor: active
                      ? activeStepBackground
                      : stepBackground,
                    borderColor: active ? colors.blue : colors.border,
                  },
                ]}
              >
                {done ? (
                  <View
                    style={[
                      styles.analyzingStepCheck,
                      { backgroundColor: colors.green },
                    ]}
                  >
                    <Text style={styles.analyzingStepCheckGlyph}>✓</Text>
                  </View>
                ) : active ? (
                  <View style={styles.analyzingStepSpinnerWrap}>
                    <ActivityIndicator size="small" color={colors.blue} />
                  </View>
                ) : (
                  <View
                    style={[
                      styles.analyzingStepDot,
                      { borderColor: colors.muted },
                    ]}
                  />
                )}
                <Text
                  style={[
                    styles.analyzingStepLabel,
                    active && styles.analyzingStepLabelActive,
                    { color: active || done ? colors.text : colors.secondary },
                  ]}
                >
                  {step}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function computeAnalysisProgress(document: DocumentRecord): number {
  if (document.status === "ready") return 100;
  const startedAt = new Date(document.createdAt).getTime();
  const elapsedSec = Number.isNaN(startedAt)
    ? 0
    : Math.max(0, (Date.now() - startedAt) / 1000);
  if (document.status === "queued") {
    return Math.min(18, Math.round(10 + elapsedSec * 0.8));
  }
  const progress = 20 + 75 * (1 - Math.exp(-elapsedSec / 45));
  return Math.max(20, Math.min(95, Math.round(progress)));
}

function HomeScreen(props: {
  documents: DocumentRecord[];
  colors: Palette;
  darkMode: boolean;
  loading: boolean;
  notice?: string;
  error?: string;
  onUpload: () => void;
  onOpenDocument: (document: DocumentRecord, tab?: ReportTab) => void;
  onDeleteDocument: (document: DocumentRecord) => void;
  deletingDocumentId?: string;
  onViewAll: () => void;
  onToggleTheme: () => void;
  onNotifications: () => void;
  onSignOut: () => void;
}) {
  const readyDocuments = props.documents.filter(
    (document) => document.status === "ready",
  );
  return (
    <>
      <View style={styles.topBar}>
        <Logo small colors={props.colors} />
        <View style={styles.topBarActions}>
          <ThemeToggle
            darkMode={props.darkMode}
            colors={props.colors}
            onPress={props.onToggleTheme}
          />
          <Pressable
            accessibilityLabel="Notifications"
            onPress={props.onNotifications}
            style={[styles.roundButton, { backgroundColor: props.colors.surface }]}
          >
            <View style={styles.notificationGlyphWrap}>
              <Text
                style={[
                  styles.roundButtonGlyph,
                  { color: props.colors.text },
                ]}
              >
                ◉
              </Text>
              <View
                style={[
                  styles.notificationDot,
                  { backgroundColor: props.colors.red },
                ]}
              />
            </View>
          </Pressable>
          <Pressable
            accessibilityLabel="Sign out"
            onPress={props.onSignOut}
            style={[
              styles.profileButton,
              { backgroundColor: props.colors.blueSoft },
            ]}
          >
            <Text style={[styles.profileGlyph, { color: props.colors.blue }]}>
              U
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.homeIntro}>
        <Text style={[styles.title, { color: props.colors.text }]}>
          Analyze DRHPs with AI
        </Text>
        <Text style={[styles.subtitle, { color: props.colors.secondary }]}>
          Get company summaries, financials, risks, and IPO details instantly.
        </Text>
      </View>

      <Pressable
        disabled={props.loading}
        onPress={props.onUpload}
        style={[styles.uploadCard, { backgroundColor: props.colors.blue }]}
      >
        <View style={styles.uploadIcon}>
          {props.loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.uploadGlyph}>↑</Text>
          )}
        </View>
        <View style={styles.flex}>
          <Text style={styles.uploadTitle}>
            {props.loading ? "Uploading…" : "Upload DRHP (PDF)"}
          </Text>
          <Text style={styles.uploadSubtitle}>Up to 20 MB · PDF</Text>
        </View>
        <Text style={styles.uploadArrow}>›</Text>
      </Pressable>

      {props.notice ? (
        <Text style={[styles.inlineNotice, { color: props.colors.green }]}>
          {props.notice}
        </Text>
      ) : null}
      {props.error ? (
        <Text style={[styles.inlineNotice, { color: props.colors.red }]}>
          {props.error}
        </Text>
      ) : null}

      <View style={styles.featureGrid}>
        <FeatureTile
          glyph="▤"
          title="Company Summary"
          subtitle="Business overview"
          colors={props.colors}
          onPress={() =>
            readyDocuments[0]
              ? props.onOpenDocument(readyDocuments[0], "Overview")
              : props.onViewAll()
          }
        />
        <FeatureTile
          glyph="▥"
          title="Financials"
          subtitle="Revenue & trends"
          colors={props.colors}
          onPress={() =>
            readyDocuments[0]
              ? props.onOpenDocument(readyDocuments[0], "Financials")
              : props.onViewAll()
          }
        />
        <FeatureTile
          glyph="△"
          title="Key Risks"
          subtitle="What to watch"
          colors={props.colors}
          onPress={() =>
            readyDocuments[0]
              ? props.onOpenDocument(readyDocuments[0], "Risks")
              : props.onViewAll()
          }
        />
        <FeatureTile
          glyph="◈"
          title="IPO Details"
          subtitle="Issue information"
          colors={props.colors}
          onPress={() =>
            readyDocuments[0]
              ? props.onOpenDocument(readyDocuments[0], "IPO")
              : props.onViewAll()
          }
        />
      </View>

      <View style={styles.sectionHeading}>
        <Text style={[styles.sectionTitle, { color: props.colors.text }]}>
          Recent analyses
        </Text>
        <Pressable onPress={props.onViewAll}>
          <Text style={[styles.link, { color: props.colors.blue }]}>View all</Text>
        </Pressable>
      </View>
      {props.documents.length === 0 ? (
        <EmptyState
          title="Your research starts here"
          description="Upload a DRHP to get a cited overview, financials, key risks, and IPO details."
          colors={props.colors}
        />
      ) : (
        props.documents.slice(0, 3).map((document) => (
          <DocumentRow
            key={document.documentId}
            document={document}
            colors={props.colors}
            onPress={() => props.onOpenDocument(document)}
            onDelete={() => props.onDeleteDocument(document)}
            deleting={props.deletingDocumentId === document.documentId}
          />
        ))
      )}
    </>
  );
}

function DocumentsScreen(props: {
  documents: DocumentRecord[];
  colors: Palette;
  loading: boolean;
  error?: string;
  onOpenDocument: (document: DocumentRecord) => void;
  onUpload: () => void;
}) {
  return (
    <>
      <View style={styles.pageHeader}>
        <Text style={[styles.title, { color: props.colors.text }]}>My documents</Text>
        <Text style={[styles.subtitle, { color: props.colors.secondary }]}>
          Your uploaded prospectuses and analysis status.
        </Text>
      </View>
      {props.error ? (
        <Text style={[styles.inlineNotice, { color: props.colors.red }]}>
          {props.error}
        </Text>
      ) : null}
      {props.documents.length === 0 && !props.loading ? (
        <EmptyState
          title="No documents yet"
          description="Upload a DRHP PDF to begin your analysis."
          colors={props.colors}
        />
      ) : (
        props.documents.map((document) => (
          <DocumentRow
            key={document.documentId}
            document={document}
            colors={props.colors}
            onPress={() => props.onOpenDocument(document)}
          />
        ))
      )}
      <PrimaryButton
        title="Upload a DRHP"
        onPress={props.onUpload}
        colors={props.colors}
      />
    </>
  );
}

function ReportScreen(props: {
  document: DocumentRecord;
  reportTab: ReportTab;
  setReportTab: (tab: ReportTab) => void;
  insight?: DocumentInsightResponse;
  loading: boolean;
  error?: string;
  colors: Palette;
  onBack: () => void;
  onAsk: () => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <>
      <View style={styles.reportTopBar}>
        <Pressable onPress={props.onBack} style={styles.backButton}>
          <Text style={[styles.backGlyph, { color: props.colors.text }]}>‹</Text>
        </Pressable>
        <View style={styles.flex}>
          <Text
            numberOfLines={1}
            style={[styles.reportFileName, { color: props.colors.text }]}
          >
            {props.document.filename}
          </Text>
          <Text style={[styles.statusCaption, { color: props.colors.secondary }]}>
            {statusText(props.document.status)}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Refresh document status"
          onPress={() => props.onRefresh()}
        >
          <Text style={[styles.roundButtonGlyph, { color: props.colors.secondary }]}>
            ↻
          </Text>
        </Pressable>
      </View>
      {props.error ? (
        <Text style={[styles.inlineNotice, { color: props.colors.red }]}>
          {props.error}
        </Text>
      ) : null}
      <ScrollView
        contentContainerStyle={styles.reportScroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.reportTabs}>
          {(["Overview", "Financials", "Risks", "IPO"] as const).map((tab) => (
            <Pressable
              key={tab}
              onPress={() => props.setReportTab(tab)}
              style={[
                styles.reportTab,
                props.reportTab === tab && {
                  borderBottomColor: props.colors.blue,
                },
              ]}
            >
              <Text
                style={[
                  styles.reportTabText,
                  {
                    color:
                      props.reportTab === tab
                        ? props.colors.blue
                        : props.colors.secondary,
                  },
                ]}
              >
                {tab}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.companyCard}>
          <View style={[styles.companyMark, { backgroundColor: props.colors.blueSoft }]}>
            <Text style={[styles.companyMarkText, { color: props.colors.blue }]}>
              PDF
            </Text>
          </View>
          <View style={styles.flex}>
            <Text style={[styles.companyName, { color: props.colors.text }]}>
              {companyNameFromFile(props.document.filename)}
            </Text>
            <Text style={[styles.statusCaption, { color: props.colors.secondary }]}>
              AI-powered prospectus analysis
            </Text>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: props.colors.text }]}>
          {props.reportTab === "Overview"
            ? "Company overview"
            : props.reportTab === "IPO"
              ? "IPO details"
              : props.reportTab === "Risks"
                ? "Key risks"
                : "Financial highlights"}
        </Text>
        {props.document.status !== "ready" ? (
          <EmptyState
            title={
              props.document.status === "failed"
                ? "Analysis couldn’t be completed"
                : "Analysis in progress"
            }
            description={
              props.document.error?.message ??
              "We’re extracting the prospectus. This view will update when it is ready."
            }
            colors={props.colors}
          />
        ) : props.loading ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color={props.colors.blue} />
            <Text style={[styles.loadingText, { color: props.colors.secondary }]}>
              Extracting structured charts & verified data points…
            </Text>
          </View>
        ) : props.error ? (
          <View style={[styles.answerCard, { backgroundColor: props.colors.surface }]}>
            <Text style={[styles.answerText, { color: props.colors.red }]}>
              {props.error}
            </Text>
            <Pressable
              onPress={() => props.onRefresh()}
              style={[
                styles.retryChip,
                {
                  backgroundColor: props.colors.blueSoft,
                  borderColor: props.colors.blue,
                },
              ]}
            >
              <Text style={[styles.link, { color: props.colors.blue }]}>
                Retry
              </Text>
            </Pressable>
          </View>
        ) : props.insight ? (
          <ReportInsightView
            insight={props.insight}
            colors={props.colors}
            onRetry={() => {
              props.onRefresh();
            }}
          />
        ) : null}

        <View style={styles.sectionHeading}>
          <Text style={[styles.sectionTitle, { color: props.colors.text }]}>
            Ask about this DRHP
          </Text>
        </View>
        <Text style={[styles.subtitle, { color: props.colors.secondary }]}>
          Ask follow-up questions and get answers linked to source pages.
        </Text>
        <PrimaryButton
          title="Ask AI about this DRHP"
          onPress={props.onAsk}
          colors={props.colors}
        />
      </ScrollView>
    </>
  );
}

function ChatScreen(props: {
  documents: DocumentRecord[];
  selectedDocumentId?: string;
  messages: ChatMessage[];
  question: string;
  loading: boolean;
  error?: string;
  colors: Palette;
  keyboardVisible: boolean;
  onSelectDocument: (id: string) => void;
  onQuestionChange: (value: string) => void;
  onSend: (question?: string, retryMessageId?: string) => void;
  onFeedback: (
    messageId: string,
    rating: "helpful" | "not_helpful",
  ) => void;
  feedbackLoadingId?: string;
  onOpenDocument: (document: DocumentRecord) => void;
}) {
  const chatMessagesRef = useRef<ScrollView>(null);
  const selected = props.documents.find(
    (document) => document.documentId === props.selectedDocumentId,
  );
  const documentMessages = useMemo(
    () =>
      selected
        ? props.messages.filter(
            (message) => message.documentId === selected.documentId,
          )
        : [],
    [props.messages, selected],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      chatMessagesRef.current?.scrollToEnd({ animated: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.loading, documentMessages.length, props.keyboardVisible]);

  return (
    <View style={styles.fill}>
      <View
        style={[
          styles.chatHeader,
          props.keyboardVisible && styles.chatHeaderCompact,
        ]}
      >
        <View style={styles.chatHeaderTopRow}>
          <Text
            style={[
              props.keyboardVisible ? styles.chatTitleCompact : styles.title,
              { color: props.colors.text },
            ]}
          >
            Ask AI
          </Text>
          {selected && (
            <Pressable
              onPress={() => props.onOpenDocument(selected)}
              style={[
                styles.reportLinkPill,
                {
                  backgroundColor: props.colors.blueSoft,
                  borderColor: props.colors.border,
                },
              ]}
            >
              <Text style={[styles.link, { color: props.colors.blue }]}>
                Report details ›
              </Text>
            </Pressable>
          )}
        </View>
        {!props.keyboardVisible && (
          <Text style={[styles.subtitle, { color: props.colors.secondary }]}>
            Answers are grounded in the selected prospectus.
          </Text>
        )}
      </View>

      {props.error ? (
        <Text
          style={[
            styles.inlineNotice,
            styles.chatHorizontalInset,
            { color: props.colors.red },
          ]}
        >
          {props.error}
        </Text>
      ) : null}

      {props.documents.length > 0 && (
        <View style={styles.documentPillsContainer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.documentPillsScroll}
            contentContainerStyle={styles.documentPills}
            keyboardShouldPersistTaps="handled"
          >
            {props.documents.map((document) => {
              const active = document.documentId === selected?.documentId;
              return (
                <Pressable
                  key={document.documentId}
                  onPress={() => props.onSelectDocument(document.documentId)}
                  style={[
                    styles.documentPill,
                    {
                      backgroundColor: active
                        ? props.colors.blueSoft
                        : props.colors.surface,
                      borderColor: active ? props.colors.blue : props.colors.border,
                    },
                  ]}
                >
                  <StatusDot status={document.status} colors={props.colors} />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.documentPillText,
                      { color: active ? props.colors.blue : props.colors.secondary },
                    ]}
                  >
                    {document.filename}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      <ScrollView
        ref={chatMessagesRef}
        style={styles.chatMessages}
        contentContainerStyle={styles.chatMessagesContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onContentSizeChange={() => {
          chatMessagesRef.current?.scrollToEnd({ animated: true });
        }}
      >
        {!selected ? (
          <EmptyState
            title="Choose a document"
            description="Upload a DRHP or select one above to ask questions."
            colors={props.colors}
          />
        ) : (
          <>
            {documentMessages.length === 0 && (
              <View
                style={[
                  styles.assistantWelcome,
                  {
                    backgroundColor: props.colors.surface,
                    borderColor: props.colors.border,
                  },
                ]}
              >
                <View style={styles.aiLabelRow}>
                  <View style={[styles.aiStar, { backgroundColor: props.colors.blue }]}>
                    <Text style={styles.aiStarText}>✦</Text>
                  </View>
                  <Text style={[styles.assistantTitle, { color: props.colors.text }]}>
                    Ask anything about this DRHP
                  </Text>
                </View>
                <Text style={[styles.subtitle, { color: props.colors.secondary }]}>
                  I’ll answer from {companyNameFromFile(selected.filename)} and include source page references when available.
                </Text>
              </View>
            )}
            {documentMessages.map((message) => (
              <View key={message.id} style={styles.messageGroup}>
                <View style={[styles.userBubble, { backgroundColor: props.colors.blue }]}>
                  <Text style={styles.userBubbleText}>{message.question}</Text>
                </View>
                {message.response ? (
                  <View
                    style={[
                      styles.chatAnswerCard,
                      {
                        backgroundColor: props.colors.surface,
                        borderColor: props.colors.border,
                      },
                    ]}
                  >
                    <View style={styles.aiLabelRow}>
                      <View style={[styles.aiStar, { backgroundColor: props.colors.blue }]}>
                        <Text style={styles.aiStarText}>✦</Text>
                      </View>
                      <Text style={[styles.aiLabel, { color: props.colors.secondary }]}>
                        DRHP Insight
                      </Text>
                    </View>
                    <AnswerCard
                      response={message.response}
                      colors={props.colors}
                      embedded
                    />
                    <View style={styles.feedbackRow}>
                      <Pressable
                        accessibilityLabel="Mark answer helpful"
                        disabled={
                          Boolean(message.feedbackRating) ||
                          props.feedbackLoadingId === message.id
                        }
                        onPress={() => props.onFeedback(message.id, "helpful")}
                      >
                        <Text
                          style={[
                            styles.feedbackGlyph,
                            {
                              color:
                                message.feedbackRating === "helpful"
                                  ? props.colors.blue
                                  : props.colors.muted,
                            },
                          ]}
                        >
                          👍
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityLabel="Mark answer not helpful"
                        disabled={
                          Boolean(message.feedbackRating) ||
                          props.feedbackLoadingId === message.id
                        }
                        onPress={() =>
                          props.onFeedback(message.id, "not_helpful")
                        }
                      >
                        <Text
                          style={[
                            styles.feedbackGlyph,
                            {
                              color:
                                message.feedbackRating === "not_helpful"
                                  ? props.colors.blue
                                  : props.colors.muted,
                            },
                          ]}
                        >
                          👎
                        </Text>
                      </Pressable>
                      {message.feedbackRating ? (
                        <Text style={[styles.feedbackMessage, { color: props.colors.green }]}>
                          Feedback saved
                        </Text>
                      ) : null}
                      {message.feedbackError ? (
                        <Text style={[styles.feedbackMessage, { color: props.colors.red }]}>
                          {message.feedbackError}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ) : message.error ? (
                  <View
                    style={[
                      styles.chatErrorCard,
                      {
                        backgroundColor: props.colors.surface,
                        borderColor: props.colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chatErrorText,
                        { color: props.colors.red },
                      ]}
                    >
                      {message.error}
                    </Text>
                    <Pressable
                      disabled={props.loading}
                      onPress={() => props.onSend(message.question, message.id)}
                      style={[
                        styles.retryChip,
                        {
                          backgroundColor: props.colors.blueSoft,
                          borderColor: props.colors.blue,
                        },
                      ]}
                    >
                      <Text style={[styles.link, { color: props.colors.blue }]}>
                        Retry
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ))}
            {props.loading && (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={props.colors.blue} />
                <Text style={[styles.loadingText, { color: props.colors.secondary }]}>
                  Searching the prospectus…
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      {selected && !props.keyboardVisible && (
        <View style={styles.promptStripWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.promptStripScroll}
            contentContainerStyle={styles.promptStripContent}
            keyboardShouldPersistTaps="handled"
          >
            {suggestedQuestions.map((suggestion) => (
              <Pressable
                key={suggestion}
                disabled={props.loading}
                onPress={() => props.onSend(suggestion)}
                style={[
                  styles.promptChip,
                  {
                    backgroundColor: props.colors.surface,
                    borderColor: props.colors.border,
                  },
                ]}
              >
                <Text style={[styles.promptText, { color: props.colors.secondary }]}>
                  {suggestion}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {selected && (
        <View
          style={[
            styles.chatComposerWrap,
            {
              backgroundColor: props.colors.background,
              borderTopColor: props.colors.border,
            },
          ]}
        >
          <View
            style={[
              styles.chatComposer,
              {
                backgroundColor: props.colors.surface,
                borderColor: props.colors.border,
              },
            ]}
          >
            <TextInput
              value={props.question}
              onChangeText={props.onQuestionChange}
              placeholder="Ask anything about this DRHP…"
              placeholderTextColor={props.colors.muted}
              multiline
              style={[styles.chatInput, { color: props.colors.text }]}
              onSubmitEditing={() => props.onSend()}
              returnKeyType="send"
            />
            <Pressable
              accessibilityLabel="Send question"
              disabled={!props.question.trim() || props.loading}
              onPress={() => props.onSend()}
              style={[
                styles.sendButton,
                {
                  backgroundColor: props.question.trim()
                    ? props.colors.blue
                    : props.colors.border,
                },
              ]}
            >
              <Text style={styles.sendGlyph}>↑</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function InsightsScreen(props: {
  documents: DocumentRecord[];
  colors: Palette;
  onOpenDocument: (document: DocumentRecord) => void;
}) {
  const counts = useMemo(
    () => ({
      total: props.documents.length,
      ready: props.documents.filter((item) => item.status === "ready").length,
      processing: props.documents.filter(
        (item) => item.status === "queued" || item.status === "processing",
      ).length,
      failed: props.documents.filter((item) => item.status === "failed").length,
    }),
    [props.documents],
  );
  return (
    <>
      <View style={styles.pageHeader}>
        <Text style={[styles.title, { color: props.colors.text }]}>Insights</Text>
        <Text style={[styles.subtitle, { color: props.colors.secondary }]}>
          A quick view of your DRHP research workspace.
        </Text>
      </View>
      <View style={styles.statsGrid}>
        <StatCard label="Documents" value={counts.total} colors={props.colors} />
        <StatCard label="Analyzed" value={counts.ready} colors={props.colors} />
        <StatCard label="In progress" value={counts.processing} colors={props.colors} />
        <StatCard label="Needs attention" value={counts.failed} colors={props.colors} />
      </View>
      <Text style={[styles.sectionTitle, { color: props.colors.text }]}>
        Latest analyses
      </Text>
      {props.documents.length === 0 ? (
        <EmptyState
          title="No insights yet"
          description="Your analysis activity will appear here after you upload a DRHP."
          colors={props.colors}
        />
      ) : (
        props.documents.slice(0, 5).map((document) => (
          <DocumentRow
            key={document.documentId}
            document={document}
            colors={props.colors}
            onPress={() => props.onOpenDocument(document)}
          />
        ))
      )}
    </>
  );
}

function AnswerCard({
  response,
  colors,
  embedded = false,
}: {
  response: QueryResponse;
  colors: Palette;
  embedded?: boolean;
}) {
  return (
    <View
      style={
        embedded
          ? undefined
          : [styles.answerCard, { backgroundColor: colors.surface }]
      }
    >
      <Text style={[styles.answerText, { color: colors.text }]}>
        {response.answer}
      </Text>
      {response.citations.length > 0 ? (
        <>
          <Text style={[styles.sourceLabel, { color: colors.secondary }]}>
            Sources
          </Text>
          <View style={styles.sourceList}>
            {response.citations.map((citation) => (
              <View
                key={citation.chunkId}
                style={[
                  styles.sourcePill,
                  { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
                ]}
              >
                <Text style={[styles.sourcePillTitle, { color: colors.blue }]}>
                  {citation.page ? `Page ${citation.page}` : "DRHP source"}
                </Text>
                <Text
                  numberOfLines={3}
                  style={[styles.sourceText, { color: colors.secondary }]}
                >
                  {citation.text}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : (
        <Text style={[styles.sourceText, { color: colors.muted }]}>
          No source pages were returned for this answer.
        </Text>
      )}
    </View>
  );
}

function DocumentRow({
  document,
  colors,
  onPress,
  onDelete,
  deleting = false,
}: {
  document: DocumentRecord;
  colors: Palette;
  onPress: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const row = (
    <Pressable
      onPress={onPress}
      style={[
        styles.documentRow,
        onDelete ? styles.documentRowActionable : undefined,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={[styles.pdfBadge, { backgroundColor: colors.blueSoft }]}>
        <Text style={[styles.pdfBadgeText, { color: colors.blue }]}>PDF</Text>
      </View>
      <View style={styles.flex}>
        <Text numberOfLines={1} style={[styles.documentTitle, { color: colors.text }]}>
          {document.filename}
        </Text>
        <View style={styles.documentMetaRow}>
          <StatusDot status={document.status} colors={colors} />
          <Text style={[styles.documentMeta, { color: colors.secondary }]}>
            {statusText(document.status)}
          </Text>
          <Text style={[styles.documentMeta, { color: colors.muted }]}>
            · {formatDate(document.updatedAt)}
          </Text>
        </View>
        {document.error ? (
          <Text numberOfLines={1} style={[styles.documentMeta, { color: colors.red }]}>
            {document.error.message}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
    </Pressable>
  );

  if (!onDelete) return row;

  return (
    <View style={styles.documentRowWithDelete}>
      {row}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${document.filename}`}
        disabled={deleting}
        onPress={onDelete}
        style={[
          styles.deleteDocumentButton,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        {deleting ? (
          <ActivityIndicator size="small" color={colors.red} />
        ) : (
          <Text style={[styles.deleteDocumentButtonText, { color: colors.red }]}>
            Delete
          </Text>
        )}
      </Pressable>
    </View>
  );
}

function StatusDot({
  status,
  colors,
}: {
  status: DocumentRecord["status"];
  colors: Palette;
}) {
  const color =
    status === "ready"
      ? colors.green
      : status === "failed"
        ? colors.red
        : colors.blue;
  return <View style={[styles.statusDot, { backgroundColor: color }]} />;
}

function FeatureTile({
  glyph,
  title,
  subtitle,
  colors,
  onPress,
}: {
  glyph: string;
  title: string;
  subtitle: string;
  colors: Palette;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.featureTile,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.featureGlyph, { color: colors.blue }]}>{glyph}</Text>
      <Text style={[styles.featureTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.featureSubtitle, { color: colors.secondary }]}>
        {subtitle}
      </Text>
    </Pressable>
  );
}

function StatCard({
  label,
  value,
  colors,
}: {
  label: string;
  value: number;
  colors: Palette;
}) {
  return (
    <View
      style={[
        styles.statCard,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.statValue, { color: colors.blue }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.secondary }]}>{label}</Text>
    </View>
  );
}

function EmptyState({
  title,
  description,
  colors,
}: {
  title: string;
  description: string;
  colors: Palette;
}) {
  return (
    <View
      style={[
        styles.emptyCard,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={[styles.emptyMark, { backgroundColor: colors.blueSoft }]}>
        <Text style={[styles.emptyMarkGlyph, { color: colors.blue }]}>✦</Text>
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.emptyDescription, { color: colors.secondary }]}>
        {description}
      </Text>
    </View>
  );
}

function Field({
  label,
  colors,
  rightLabel,
  onRightPress,
  ...inputProps
}: React.ComponentProps<typeof TextInput> & {
  label: string;
  colors: Palette;
  rightLabel?: string;
  onRightPress?: () => void;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={[styles.fieldLabel, { color: colors.secondary }]}>{label}</Text>
      <View
        style={[
          styles.fieldShell,
          { backgroundColor: colors.input, borderColor: colors.border },
        ]}
      >
        <TextInput
          {...inputProps}
          placeholderTextColor={colors.muted}
          style={[styles.fieldInput, { color: colors.text }]}
        />
        {rightLabel && onRightPress ? (
          <Pressable onPress={onRightPress}>
            <Text style={[styles.link, { color: colors.blue }]}>{rightLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function PrimaryButton({
  title,
  onPress,
  colors,
  loading = false,
}: {
  title: string;
  onPress: () => void;
  colors: Palette;
  loading?: boolean;
}) {
  return (
    <Pressable
      disabled={loading}
      onPress={onPress}
      style={[styles.primaryButton, { backgroundColor: colors.blue }]}
    >
      {loading ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <Text style={styles.primaryButtonText}>{title}</Text>
      )}
    </Pressable>
  );
}

function ThemeToggle({
  darkMode,
  colors,
  onPress,
}: {
  darkMode: boolean;
  colors: Palette;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={darkMode ? "Switch to light mode" : "Switch to dark mode"}
      onPress={onPress}
      style={[styles.roundButton, { backgroundColor: colors.surface }]}
    >
      <Text style={[styles.roundButtonGlyph, { color: colors.text }]}>
        {darkMode ? "☼" : "☾"}
      </Text>
    </Pressable>
  );
}

function BottomNavigation({
  activeTab,
  setActiveTab,
  colors,
}: {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  colors: Palette;
}) {
  const items: Array<{ key: AppTab; label: string; glyph: string }> = [
    { key: "home", label: "Home", glyph: "⌂" },
    { key: "documents", label: "My Docs", glyph: "▤" },
    { key: "chat", label: "Chat", glyph: "◌" },
    { key: "insights", label: "Insights", glyph: "▥" },
  ];
  return (
    <View
      style={[
        styles.bottomNavigation,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      {items.map((item) => {
        const selected = item.key === activeTab;
        return (
          <Pressable
            key={item.key}
            onPress={() => setActiveTab(item.key)}
            style={styles.navItem}
          >
            <Text
              style={[
                styles.navGlyph,
                { color: selected ? colors.blue : colors.muted },
              ]}
            >
              {item.glyph}
            </Text>
            <Text
              style={[
                styles.navLabel,
                { color: selected ? colors.blue : colors.muted },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function authHeading(stage: AuthStage): string {
  switch (stage) {
    case "signUp":
      return "Create your account";
    case "confirmSignUp":
      return "Verify your email";
    case "challenge":
      return "Verify your sign-in";
    case "forgotPassword":
      return "Reset your password";
    case "confirmPasswordReset":
      return "Choose a new password";
    default:
      return "Welcome back";
  }
}

function authSubtitle(stage: AuthStage): string {
  switch (stage) {
    case "signUp":
      return "Start analyzing DRHPs with AI.";
    case "confirmSignUp":
      return "Enter the one-time code sent by Cognito.";
    case "challenge":
      return "Complete the verification step required by your Cognito pool.";
    case "forgotPassword":
      return "We’ll send a reset code to your registered email.";
    case "confirmPasswordReset":
      return "Use the code from your email to set a new password.";
    default:
      return "Sign in to continue your research.";
  }
}

function authButtonLabel(stage: AuthStage): string {
  switch (stage) {
    case "signUp":
      return "Create account";
    case "confirmSignUp":
    case "challenge":
      return "Verify";
    case "forgotPassword":
      return "Send reset code";
    case "confirmPasswordReset":
      return "Update password";
    default:
      return "Sign in";
  }
}

function statusText(status: DocumentRecord["status"]): string {
  switch (status) {
    case "ready":
      return "Analyzed";
    case "processing":
      return "Analyzing";
    case "failed":
      return "Analysis failed";
    default:
      return "Queued";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function companyNameFromFile(filename: string): string {
  return filename
    .replace(/\.pdf$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function queryCacheKey(
  documentId: string,
  updatedAt: string | undefined,
  question: string,
): string {
  return `${documentId}::${updatedAt ?? ""}::${normalizeQuestion(question)}`;
}

function clearDocumentCache<T>(cache: Map<string, T>, documentId: string): void {
  const prefix = `${documentId}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  fill: { flex: 1 },
  flex: { flex: 1 },
  authScroll: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 28 },
  authHeader: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  authIntro: { marginTop: 44, marginBottom: 30 },
  logoLockup: { flexDirection: "row", alignItems: "center", gap: 9 },
  logoImage: { width: 36, height: 36, borderRadius: 9 },
  logoImageSmall: { width: 32, height: 32, borderRadius: 8 },
  logoName: { color: "#F4F7FF", fontSize: 17, fontWeight: "700" },
  logoNameSmall: { fontSize: 15 },
  heading: { fontSize: 26, lineHeight: 33, fontWeight: "700" },
  title: { fontSize: 23, lineHeight: 30, fontWeight: "700" },
  subtitle: { marginTop: 6, fontSize: 13, lineHeight: 19 },
  fieldGroup: { marginBottom: 16 },
  fieldLabel: { marginBottom: 7, fontSize: 12, fontWeight: "600" },
  fieldShell: {
    minHeight: 50,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  fieldInput: { flex: 1, paddingVertical: 11, fontSize: 14 },
  termsRow: { marginTop: 1, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 9 },
  checkbox: { width: 17, height: 17, borderWidth: 1, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  checkboxCheck: { color: "#FFFFFF", fontSize: 11, fontWeight: "800", lineHeight: 14 },
  termsText: { flex: 1, fontSize: 11, lineHeight: 16 },
  primaryButton: {
    minHeight: 49,
    marginTop: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  primaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  link: { fontSize: 12, fontWeight: "600" },
  forgotLink: { alignSelf: "flex-end", paddingVertical: 14 },
  localPreview: {
    marginTop: 13,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    columnGap: 12,
    rowGap: 15,
  },
  divider: { width: 80, height: 1 },
  orText: { fontSize: 12 },
  secondaryButton: {
    width: "100%",
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: { fontSize: 13, fontWeight: "600" },
  authFooter: { flex: 1, minHeight: 75, alignItems: "center", justifyContent: "flex-end" },
  footerText: { fontSize: 12 },
  notice: { marginVertical: 8, fontSize: 12, lineHeight: 18 },
  error: { marginVertical: 8, fontSize: 12, lineHeight: 18 },
  mainScroll: { paddingHorizontal: 19, paddingTop: 10, paddingBottom: 26 },
  topBar: {
    marginBottom: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topBarActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  profileButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  profileGlyph: { fontSize: 12, fontWeight: "800" },
  roundButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  roundButtonGlyph: { fontSize: 19, fontWeight: "600" },
  notificationGlyphWrap: { position: "relative" },
  notificationDot: { position: "absolute", top: 0, right: -2, width: 6, height: 6, borderRadius: 3 },
  homeIntro: { marginBottom: 17 },
  uploadCard: {
    minHeight: 82,
    paddingHorizontal: 15,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    shadowColor: "#1468E6",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 3,
  },
  uploadIcon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  uploadGlyph: { fontSize: 27, lineHeight: 30, fontWeight: "500", color: "#FFFFFF" },
  uploadTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  uploadSubtitle: { color: "#E3EEFF", marginTop: 4, fontSize: 11 },
  uploadArrow: { color: "#FFFFFF", fontSize: 25, fontWeight: "300" },
  inlineNotice: { marginTop: 10, fontSize: 12, lineHeight: 18 },
  featureGrid: {
    marginTop: 17,
    marginBottom: 25,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  featureTile: {
    width: "48%",
    minHeight: 103,
    padding: 12,
    borderWidth: 1,
    borderRadius: 14,
  },
  featureGlyph: { fontSize: 20, fontWeight: "700", marginBottom: 7 },
  featureTitle: { fontSize: 12, fontWeight: "700" },
  featureSubtitle: { fontSize: 10, marginTop: 4 },
  sectionHeading: {
    marginBottom: 11,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionTitle: { marginTop: 5, marginBottom: 11, fontSize: 16, fontWeight: "700" },
  documentRow: {
    minHeight: 70,
    paddingHorizontal: 11,
    paddingVertical: 10,
    marginBottom: 9,
    borderWidth: 1,
    borderRadius: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  documentRowWithDelete: {
    marginBottom: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  documentRowActionable: { flex: 1, marginBottom: 0 },
  deleteDocumentButton: {
    minWidth: 56,
    height: 44,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteDocumentButtonText: { fontSize: 10, fontWeight: "700" },
  pdfBadge: { width: 36, height: 40, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  pdfBadgeText: { fontSize: 9, fontWeight: "800" },
  documentTitle: { fontSize: 12, fontWeight: "600" },
  documentMetaRow: { marginTop: 6, flexDirection: "row", alignItems: "center", gap: 5 },
  documentMeta: { fontSize: 10 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  chevron: { fontSize: 24, fontWeight: "300" },
  pageHeader: { marginTop: 10, marginBottom: 20 },
  emptyCard: {
    padding: 19,
    marginVertical: 10,
    borderWidth: 1,
    borderRadius: 15,
    alignItems: "center",
  },
  emptyMark: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  emptyMarkGlyph: { fontSize: 19 },
  emptyTitle: { marginTop: 12, fontSize: 14, fontWeight: "700", textAlign: "center" },
  emptyDescription: { marginTop: 6, fontSize: 12, lineHeight: 18, textAlign: "center" },
  bottomNavigation: {
    minHeight: 65,
    paddingHorizontal: 5,
    borderTopWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
  },
  navItem: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2 },
  navGlyph: { fontSize: 21, lineHeight: 24 },
  navLabel: { fontSize: 10, fontWeight: "600" },
  reportTopBar: {
    minHeight: 53,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  backButton: { width: 28, alignItems: "flex-start" },

  backGlyph: { fontSize: 31, lineHeight: 35, fontWeight: "300" },
  reportFileName: { fontSize: 12, fontWeight: "700" },
  statusCaption: { marginTop: 3, fontSize: 10 },
  reportScroll: { paddingHorizontal: 18, paddingBottom: 30 },
  reportTabs: { marginBottom: 16, flexDirection: "row", borderBottomWidth: 1, borderColor: "#273857" },
  reportTab: { minHeight: 39, flex: 1, alignItems: "center", justifyContent: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  reportTabText: { fontSize: 11, fontWeight: "600" },
  companyCard: {
    minHeight: 70,
    marginBottom: 20,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    borderRadius: 13,
  },
  companyMark: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  companyMarkText: { fontSize: 9, fontWeight: "800" },
  companyName: { fontSize: 13, fontWeight: "700" },
  loadingCard: { minHeight: 120, alignItems: "center", justifyContent: "center", gap: 11 },
  loadingText: { fontSize: 12, textAlign: "center" },
  answerCard: { padding: 15, borderRadius: 14, marginBottom: 14 },
  answerText: { fontSize: 13, lineHeight: 20 },
  sourceLabel: { marginTop: 15, marginBottom: 7, fontSize: 11, fontWeight: "700" },
  sourceList: { gap: 8 },
  sourcePill: { padding: 10, borderWidth: 1, borderRadius: 10 },
  sourcePillTitle: { marginBottom: 4, fontSize: 10, fontWeight: "700" },
  sourceText: { fontSize: 10, lineHeight: 15 },
  assistantWelcome: {
    padding: 16,
    borderWidth: 1,
    borderRadius: 16,
    marginBottom: 14,
  },
  assistantTitle: { fontSize: 15, fontWeight: "700" },
  chatHeader: { paddingHorizontal: 19, paddingTop: 10, paddingBottom: 10 },
  chatHeaderCompact: { paddingTop: 6, paddingBottom: 6 },
  chatHeaderTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  chatTitleCompact: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  chatHorizontalInset: { paddingHorizontal: 19, marginBottom: 8 },
  reportLinkPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
  },
  documentPillsContainer: { flexGrow: 0, flexShrink: 0 },
  documentPillsScroll: { flexGrow: 0, flexShrink: 0 },
  documentPills: {
    paddingHorizontal: 19,
    paddingBottom: 10,
    gap: 8,
    alignItems: "center",
  },
  documentPill: {
    height: 36,
    maxWidth: 220,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  documentPillText: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  promptStripWrap: { flexGrow: 0, flexShrink: 0 },
  promptStripScroll: { flexGrow: 0, flexShrink: 0 },
  promptStripContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    alignItems: "center",
  },
  promptChip: {
    height: 32,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  promptText: { fontSize: 11, fontWeight: "600" },
  chatMessages: { flex: 1 },
  chatMessagesContent: {
    flexGrow: 1,
    paddingHorizontal: 19,
    paddingTop: 6,
    paddingBottom: 14,
  },
  messageGroup: { marginBottom: 14 },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderBottomRightRadius: 4,
    marginBottom: 10,
  },
  userBubbleText: { color: "#FFFFFF", fontSize: 13, lineHeight: 19 },
  chatAnswerCard: {
    padding: 14,
    borderWidth: 1,
    borderRadius: 16,
    borderTopLeftRadius: 4,
  },
  chatErrorCard: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  chatErrorText: { flex: 1, fontSize: 12, lineHeight: 18 },
  retryChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 14,
  },
  aiLabelRow: { marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  aiStar: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  aiStarText: { color: "#FFFFFF", fontSize: 12 },
  aiLabel: { fontSize: 11, fontWeight: "700" },
  feedbackRow: { marginTop: 10, flexDirection: "row", gap: 16, alignItems: "center" },
  feedbackGlyph: { fontSize: 16 },
  feedbackMessage: { alignSelf: "center", fontSize: 10 },
  loadingRow: { padding: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  chatComposerWrap: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  chatComposer: {
    minHeight: 48,
    paddingLeft: 15,
    paddingRight: 6,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  chatInput: {
    maxHeight: 100,
    flex: 1,
    paddingVertical: 8,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: "center",
  },
  sendButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  sendGlyph: { color: "#FFFFFF", fontSize: 19, lineHeight: 22, fontWeight: "700" },
  statsGrid: { marginBottom: 20, flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statCard: { width: "48%", minHeight: 86, padding: 13, borderWidth: 1, borderRadius: 13 },
  statValue: { fontSize: 23, fontWeight: "700" },
  statLabel: { marginTop: 4, fontSize: 10 },
  analyzingBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  analyzingHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  analyzingBackButton: {
    width: 36,
    height: 36,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  analyzingBackGlyph: { fontSize: 24, fontWeight: "400" },
  analyzingHeaderTitle: { fontSize: 17, fontWeight: "700" },
  analyzingContent: {
    flexGrow: 1,
    paddingTop: 14,
    paddingBottom: 32,
  },
  analyzingDocCard: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  analyzingPdfIcon: {
    width: 40,
    height: 48,
    borderRadius: 8,
    backgroundColor: "#F4F7FF",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 6,
    overflow: "hidden",
    position: "relative",
  },
  analyzingPdfCorner: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 12,
    height: 12,
    backgroundColor: "#CBD5E1",
    borderBottomLeftRadius: 4,
  },
  analyzingPdfLabel: {
    color: "#E53935",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.4,
  },
  analyzingDocName: { fontSize: 15, fontWeight: "700" },
  analyzingDocMeta: { marginTop: 4, fontSize: 12 },
  analyzingRingSection: {
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 30,
  },
  analyzingRingHalo: {
    position: "absolute",
    width: 184,
    height: 184,
    borderRadius: 92,
  },
  analyzingRingWrap: {
    width: 152,
    height: 152,
    alignItems: "center",
    justifyContent: "center",
  },
  analyzingRingTrack: {
    position: "absolute",
    width: 152,
    height: 152,
    borderRadius: 76,
    borderWidth: 10,
  },
  analyzingHalfRight: {
    position: "absolute",
    top: 0,
    left: 76,
    width: 76,
    height: 152,
    overflow: "hidden",
  },
  analyzingCircleRight: {
    position: "absolute",
    top: 0,
    left: -76,
    width: 152,
    height: 152,
    borderRadius: 76,
    borderWidth: 10,
    borderBottomColor: "transparent",
    borderLeftColor: "transparent",
  },
  analyzingHalfLeft: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 76,
    height: 152,
    overflow: "hidden",
  },
  analyzingCircleLeft: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 152,
    height: 152,
    borderRadius: 76,
    borderWidth: 10,
    borderTopColor: "transparent",
    borderRightColor: "transparent",
  },
  analyzingRingCenter: {
    alignItems: "center",
    justifyContent: "center",
  },
  analyzingSparkle: { fontSize: 22, lineHeight: 26, marginBottom: 2 },
  analyzingPercent: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  analyzingTitle: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "700",
    textAlign: "center",
    paddingHorizontal: 12,
  },
  analyzingSubtitle: {
    marginTop: 8,
    marginBottom: 24,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 12,
  },
  analyzingSteps: { gap: 10 },
  analyzingStepRow: {
    minHeight: 48,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  analyzingStepCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  analyzingStepCheckGlyph: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
  },
  analyzingStepSpinnerWrap: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  analyzingStepDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  analyzingStepLabel: { fontSize: 13, fontWeight: "500", flex: 1 },
  analyzingStepLabelActive: { fontWeight: "700" },
});

export {
  AnalyzingOverlay,
  AnswerCard,
  BottomNavigation,
  ChatScreen,
  DocumentRow,
  DocumentsScreen,
  EmptyState,
  FeatureTile,
  Field,
  HomeScreen,
  InsightsScreen,
  KeyboardAwareContainer,
  Logo,
  PrimaryButton,
  ReportScreen,
  StatCard,
  StatusDot,
  ThemeToggle,
  palettes,
};
export type { ChatMessage, Palette, ReportTab };

export default App;
