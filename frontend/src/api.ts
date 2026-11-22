import { getAccessToken } from "./auth";
import { apiBaseUrl, uploadMode } from "./config";
import type {
  DocumentInsightResponse,
  DocumentRecord,
  InsightSection,
  QueryResponse,
} from "./types";

type ApiErrorPayload = {
  error?: {
    message?: string;
  };
};

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorPayload;
    throw new Error(
      body.error?.message ?? `Request failed with status ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const response = await request<{ documents: DocumentRecord[] }>(
    "/documents?limit=100",
  );
  return response.documents;
}

export async function uploadDrhp(file: {
  uri: string;
  name: string;
  type: string;
}): Promise<void> {
  if (uploadMode === "s3") {
    const upload = await request<{
      documentId: string;
      uploadUrl: string;
      fields: Record<string, string>;
    }>("/documents/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        documentType: "drhp",
      }),
    });
    const body = new FormData() as FormData & {
      append(name: string, value: string): void;
      append(
        name: string,
        value: { uri: string; name: string; type: string },
      ): void;
    };
    for (const [name, value] of Object.entries(upload.fields)) {
      body.append(name, value);
    }
    body.append("file", file);

    try {
      const response = await fetch(upload.uploadUrl, {
        method: "POST",
        body,
      });
      if (!response.ok) {
        throw new Error(
          `File upload failed with status ${response.status}`,
        );
      }
    } catch (error) {
      try {
        await deleteDocument(upload.documentId);
      } catch (cleanupError) {
        const uploadMessage =
          error instanceof Error ? error.message : "Unknown upload error";
        const cleanupMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : "Unknown cleanup error";
        throw new Error(
          `${uploadMessage}; pending document cleanup also failed: ${cleanupMessage}`,
        );
      }
      throw error;
    }
    return;
  }

  const body = new FormData() as FormData & {
    append(
      name: string,
      value: { uri: string; name: string; type: string },
    ): void;
  };
  body.append("file", file);
  await request("/documents", {
    method: "POST",
    headers: { "X-Document-Type": "drhp" },
    body,
  });
}

export async function askDocument(
  documentId: string,
  question: string,
): Promise<QueryResponse> {
  return request<QueryResponse>("/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, documentIds: [documentId], topK: 5 }),
  });
}

export async function getDocumentInsight(
  documentId: string,
  section: InsightSection,
): Promise<DocumentInsightResponse> {
  return request<DocumentInsightResponse>(
    `/documents/${encodeURIComponent(documentId)}/insights?section=${encodeURIComponent(section)}`,
  );
}

export async function refreshDocumentInsight(
  documentId: string,
  section: InsightSection,
): Promise<DocumentInsightResponse> {
  return request<DocumentInsightResponse>(
    `/documents/${encodeURIComponent(documentId)}/insights/refresh`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section }),
    },
  );
}

export async function submitFeedback(
  documentId: string,
  question: string,
  rating: "helpful" | "not_helpful",
): Promise<void> {
  await request(`/documents/${encodeURIComponent(documentId)}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, rating }),
  });
}

export async function deleteDocument(documentId: string): Promise<void> {
  const token = await getAccessToken();
  const response = await fetch(
    `${apiBaseUrl}/documents/${encodeURIComponent(documentId)}`,
    {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorPayload;
    throw new Error(
      body.error?.message ?? `Request failed with status ${response.status}`,
    );
  }
}
