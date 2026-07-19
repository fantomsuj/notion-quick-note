export const NOTION_API_VERSION = "2026-03-11";

export function normalizeNotionId(value = "") {
  const input = value.trim();
  const compact = input.match(/[0-9a-f]{32}/i)?.[0];
  if (compact) return compact;

  const dashed = input.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return dashed ? dashed.replaceAll("-", "") : input;
}

function richText(content, link) {
  if (!content) return [];
  return [{
    type: "text",
    text: {
      content: content.slice(0, 2000),
      ...(link ? { link: { url: link } } : {})
    }
  }];
}

function captureTitle(capture) {
  const firstLine = capture.text.trim().split("\n")[0];
  return (firstLine || capture.pageTitle || "Quick note").slice(0, 100);
}

function contentBlocks(capture) {
  const blocks = [];

  if (capture.selection?.trim()) {
    blocks.push({
      object: "block",
      type: "quote",
      quote: { rich_text: richText(capture.selection.trim()) }
    });
  }

  for (const paragraph of capture.text.trim().split(/\n{2,}/).filter(Boolean)) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(paragraph) }
    });
  }

  if (capture.includeSource && capture.url) {
    blocks.push({
      object: "block",
      type: "bookmark",
      bookmark: { url: capture.url }
    });
  }

  return blocks;
}

export function buildCaptureRequest(settings, capture, now = new Date()) {
  const destinationId = normalizeNotionId(settings.destinationId);
  if (!destinationId) throw new Error("Choose a Notion destination in Settings.");
  if (!capture.text?.trim() && !capture.selection?.trim()) {
    throw new Error("Write something before saving.");
  }

  const children = contentBlocks(capture);

  if (settings.destinationType === "database") {
    const titleProperty = settings.titleProperty?.trim() || "Name";
    return {
      path: "/v1/pages",
      method: "POST",
      body: {
        parent: { type: "data_source_id", data_source_id: destinationId },
        properties: {
          [titleProperty]: { title: richText(captureTitle(capture)) }
        },
        children
      }
    };
  }

  const sourceLine = capture.includeSource && capture.url
    ? richText(capture.pageTitle || capture.url, capture.url)
    : [];

  return {
    path: `/v1/blocks/${destinationId}/children`,
    method: "PATCH",
    body: {
      children: [
        {
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: richText(captureTitle(capture)),
            is_toggleable: false
          }
        },
        ...(sourceLine.length ? [{
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: sourceLine }
        }] : []),
        ...children.filter((block) => block.type !== "bookmark"),
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: richText(`Captured ${now.toLocaleString()}`),
            color: "gray"
          }
        },
        { object: "block", type: "divider", divider: {} }
      ]
    }
  };
}

export async function sendCapture({ token, settings, capture, fetchImpl = fetch }) {
  if (!token) throw new Error("Connect Notion in Settings first.");
  const resolvedSettings = settings.destinationType === "database"
    ? { ...settings, destinationId: await resolveDataSourceId(token, settings.destinationId, fetchImpl) }
    : settings;
  const request = buildCaptureRequest(resolvedSettings, capture);
  const response = await fetchImpl(`https://api.notion.com${request.path}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request.body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `Notion returned ${response.status}.`);
  }
  return payload;
}

async function resolveDataSourceId(token, value, fetchImpl) {
  const id = normalizeNotionId(value);
  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_API_VERSION };

  const direct = await fetchImpl(`https://api.notion.com/v1/data_sources/${id}`, { headers });
  if (direct.ok) return id;

  const database = await fetchImpl(`https://api.notion.com/v1/databases/${id}`, { headers });
  if (!database.ok) return id;
  const payload = await database.json();
  return payload.data_sources?.[0]?.id || id;
}
