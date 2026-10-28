import { WEBHOOK_EVENTS } from '../../../web/src/server/webhooks';

const ITEM_KINDS = ['meeting', 'dictation', 'note', 'image', 'video', 'audio'];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const error = (description: string) => json(ref('Error'), description);
const body = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const pathParam = (name: string, description: string, schema: unknown = { type: 'string' }) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema,
});

const ITEM_FILTERS = [
  {
    name: 'kinds',
    in: 'query',
    description: 'Only these kinds, comma-separated. Leave out for everything.',
    schema: { type: 'array', items: { type: 'string', enum: ITEM_KINDS } },
    style: 'form',
    explode: false,
  },
  { name: 'project', in: 'query', description: 'Only items filed under this project, by name. Leaves dictations out.', schema: { type: 'string' } },
  { name: 'since', in: 'query', description: 'From this ISO 8601 date or time on. Times without an offset are UTC.', schema: { type: 'string', example: '2026-10-01' } },
  { name: 'until', in: 'query', description: 'Up to this ISO 8601 date or time. A bare date includes that whole UTC day.', schema: { type: 'string' } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
];

const COMMON_ERRORS = {
  '400': error('The request is not valid. `error.message` says why.'),
  '401': error('No API key, or one that is not valid or has expired.'),
  '429': error('Too many requests for this key (120 a minute), or a daily limit was reached. See `retry-after`.'),
};
const WRITE_ERRORS = { ...COMMON_ERRORS, '403': error('The key is read-only.') };

/** The OpenAPI 3.1 description of the REST API under /v1, served at /v1/openapi.json. */
export function openApiDocument(origin: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Eavesy API',
      version: '1.0.0',
      description:
        'Read and change your Eavesy library: recordings, dictations, notes, screenshots and other captures, and action items, ' +
        'and get webhooks when new ones arrive. It runs on the same tools as the Eavesy MCP server. ' +
        'Authenticate with an API key from Eavesy settings (AI apps and API keys → New key) as `Authorization: Bearer <key>`. ' +
        'A key is read-only unless you allowed writes when you made it, and it stops working after 90 days unused. ' +
        'Errors come back as `{ "error": { "code", "message" } }`.',
    },
    servers: [{ url: `${origin}/v1` }],
    security: [{ apiKey: [] }],
    tags: [
      { name: 'Library', description: 'Everything you recorded, dictated, wrote or captured.' },
      { name: 'Action items', description: 'Tasks from your recordings’ summaries.' },
      { name: 'Webhooks', description: 'Signed POSTs to your URL when something new arrives.' },
      { name: 'Account' },
    ],
    paths: {
      '/me': {
        get: {
          tags: ['Account'],
          operationId: 'getAccount',
          summary: 'The account and key in use',
          responses: { '200': json(ref('Account')), ...COMMON_ERRORS },
        },
      },
      '/projects': {
        get: {
          tags: ['Library'],
          operationId: 'listProjects',
          summary: 'List projects',
          responses: {
            '200': json({ type: 'object', properties: { projects: { type: 'array', items: ref('Project') } }, required: ['projects'] }),
            ...COMMON_ERRORS,
          },
        },
      },
      '/items': {
        get: {
          tags: ['Library'],
          operationId: 'listItems',
          summary: 'List the newest items',
          description: 'Newest first, across every kind unless `kinds` narrows it.',
          parameters: ITEM_FILTERS,
          responses: { '200': json(ref('ItemList')), ...COMMON_ERRORS },
        },
      },
      '/search': {
        get: {
          tags: ['Library'],
          operationId: 'searchItems',
          summary: 'Search the library',
          description:
            'Matches titles and text, including text read from screenshots. Recordings and dictations also match by meaning, ' +
            'and a search that includes them counts against the daily search limit (1,000).',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 1000 } }, ...ITEM_FILTERS],
          responses: { '200': json(ref('ItemList')), ...COMMON_ERRORS },
        },
      },
      '/items/{id}': {
        get: {
          tags: ['Library'],
          operationId: 'getItem',
          summary: 'Get one item in full',
          description:
            'A recording comes with its summary, your notes and the transcript; a dictation with its text; a note with its Markdown; ' +
            'a capture with any text read from it. For a capture’s file, use /items/{id}/file.',
          parameters: [
            pathParam('id', 'An id from a list, search or webhook.'),
            {
              name: 'transcript_format',
              in: 'query',
              description: 'A recording’s transcript cleaned up for an AI agent (`agent`), or every line as heard with timestamps (`raw`).',
              schema: { type: 'string', enum: ['agent', 'raw'], default: 'agent' },
            },
          ],
          responses: { '200': json(ref('ItemDetail')), '404': error('No item of yours has that id.'), ...COMMON_ERRORS },
        },
        patch: {
          tags: ['Library'],
          operationId: 'updateItem',
          summary: 'Rename an item or file it under a project',
          description: 'Send `title`, `project` or both. Dictations have no project.',
          parameters: [pathParam('id', 'The item’s id.')],
          requestBody: body({
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 200 },
              project: { type: ['string', 'null'], description: 'A project name, or null to take the item out of its project.' },
            },
          }),
          responses: {
            '200': json({
              type: 'object',
              properties: { id: { type: 'string' }, kind: { type: 'string', enum: ITEM_KINDS }, title: { type: 'string' }, project: { type: ['string', 'null'] } },
              required: ['id', 'kind'],
            }),
            '404': error('No item of yours has that id.'),
            ...WRITE_ERRORS,
          },
        },
      },
      '/items/{id}/file': {
        get: {
          tags: ['Library'],
          operationId: 'getItemFile',
          summary: 'Download a capture’s file',
          description: 'The original bytes of a note, screenshot, image, video or audio capture, with its content type.',
          parameters: [pathParam('id', 'A capture id (`cap_…`).')],
          responses: {
            '200': { description: 'The file.', content: { '*/*': { schema: { type: 'string', contentMediaType: 'application/octet-stream' } } } },
            '404': error('No capture of yours has that id.'),
            ...COMMON_ERRORS,
          },
        },
      },
      '/notes': {
        post: {
          tags: ['Library'],
          operationId: 'createNote',
          summary: 'Save a note',
          description: 'Keeps Markdown as a note in the library. It syncs to your signed-in Macs and counts against the daily capture limit (300).',
          requestBody: body({
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Markdown, up to 1 MB.' },
              title: { type: 'string', maxLength: 200, description: 'Defaults to the first line.' },
              project: { type: 'string', description: 'A project name to file it under.' },
            },
            required: ['text'],
          }),
          responses: {
            '201': json(
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  kind: { const: 'note' },
                  title: { type: 'string' },
                  project: { type: ['string', 'null'] },
                  created_at: { type: 'string', format: 'date-time' },
                },
                required: ['id', 'kind', 'title', 'project', 'created_at'],
              },
              'Saved.',
            ),
            ...WRITE_ERRORS,
          },
        },
      },
      '/action-items': {
        get: {
          tags: ['Action items'],
          operationId: 'listActionItems',
          summary: 'List action items',
          description: 'From the 200 newest recordings with a summary, at most 200 items.',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'completed', 'all'], default: 'open' } },
            { name: 'owner', in: 'query', description: 'Only items owned by exactly this name.', schema: { type: 'string' } },
          ],
          responses: {
            '200': json({ type: 'object', properties: { action_items: { type: 'array', items: ref('ActionItem') } }, required: ['action_items'] }),
            ...COMMON_ERRORS,
          },
        },
      },
      '/meetings/{id}/action-items/{index}': {
        patch: {
          tags: ['Action items'],
          operationId: 'updateActionItem',
          summary: 'Mark an action item done or open',
          description:
            'Take `index` from the list. Send the item’s `text` too, and a list that changed since you read it is refused with 409 ' +
            'instead of changing the wrong item.',
          parameters: [pathParam('id', 'The recording’s id.'), pathParam('index', 'The item’s `index`.', { type: 'integer', minimum: 0 })],
          requestBody: body({
            type: 'object',
            properties: { completed: { type: 'boolean' }, text: { type: 'string', description: 'The item’s text as you read it.' } },
            required: ['completed'],
          }),
          responses: {
            '200': json(ref('ActionItemUpdate')),
            '404': error('No such recording or item.'),
            '409': error('The list changed since it was read. Read it again.'),
            ...WRITE_ERRORS,
          },
        },
      },
      '/webhooks': {
        get: {
          tags: ['Webhooks'],
          operationId: 'listWebhooks',
          summary: 'List webhook endpoints',
          responses: {
            '200': json({ type: 'object', properties: { webhooks: { type: 'array', items: ref('Webhook') } }, required: ['webhooks'] }),
            ...COMMON_ERRORS,
          },
        },
        post: {
          tags: ['Webhooks'],
          operationId: 'createWebhook',
          summary: 'Add a webhook endpoint',
          description:
            'At most 10 per account. The response is the only time the signing secret is shown. ' +
            'A webhook added with a key sends only while that key works: revoking the key stops it.',
          requestBody: body({
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri', description: 'An https URL with a public host name.' },
              events: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS }, minItems: 1, description: 'Defaults to every event.' },
              description: { type: 'string', maxLength: 200 },
            },
            required: ['url'],
          }),
          responses: {
            '201': json(
              {
                allOf: [
                  ref('Webhook'),
                  {
                    type: 'object',
                    properties: { secret: { type: 'string', description: 'The `whsec_…` key that signs deliveries. Keep it; it is not shown again.' } },
                    required: ['secret'],
                  },
                ],
              },
              'Added.',
            ),
            ...WRITE_ERRORS,
          },
        },
      },
      '/webhooks/{id}': {
        get: {
          tags: ['Webhooks'],
          operationId: 'getWebhook',
          summary: 'Get a webhook endpoint',
          parameters: [pathParam('id', 'The endpoint’s id (`whk_…`).')],
          responses: { '200': json(ref('Webhook')), '404': error('No endpoint of yours has that id.'), ...COMMON_ERRORS },
        },
        patch: {
          tags: ['Webhooks'],
          operationId: 'updateWebhook',
          summary: 'Change a webhook endpoint, or turn it on or off',
          description: '`enabled: true` turns an endpoint back on after Eavesy turned it off for failing, and clears its failures.',
          parameters: [pathParam('id', 'The endpoint’s id.')],
          requestBody: body({
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri' },
              events: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS }, minItems: 1 },
              description: { type: 'string', maxLength: 200 },
              enabled: { type: 'boolean' },
            },
          }),
          responses: { '200': json(ref('Webhook')), '404': error('No endpoint of yours has that id.'), ...WRITE_ERRORS },
        },
        delete: {
          tags: ['Webhooks'],
          operationId: 'deleteWebhook',
          summary: 'Remove a webhook endpoint',
          parameters: [pathParam('id', 'The endpoint’s id.')],
          responses: { '204': { description: 'Removed. Deliveries still queued for it are dropped.' }, '404': error('No endpoint of yours has that id.'), ...WRITE_ERRORS },
        },
      },
      '/webhooks/{id}/test': {
        post: {
          tags: ['Webhooks'],
          operationId: 'testWebhook',
          summary: 'Send a test event now',
          description: 'POSTs one `webhook.test` event straight away, without retries, and says how the endpoint answered.',
          parameters: [pathParam('id', 'The endpoint’s id.')],
          responses: {
            '200': json({
              type: 'object',
              properties: {
                delivered: { type: 'boolean' },
                status: { type: ['integer', 'null'], description: 'The HTTP status the endpoint answered with.' },
                error: { type: ['string', 'null'] },
                event_id: { type: 'string' },
              },
              required: ['delivered', 'status', 'error', 'event_id'],
            }),
            '404': error('No endpoint of yours has that id.'),
            ...WRITE_ERRORS,
          },
        },
      },
    },
    webhooks: {
      event: {
        post: {
          summary: 'An event, POSTed to each endpoint that subscribes to it',
          description:
            'Signed as Standard Webhooks (standardwebhooks.com) sign: `webhook-signature` is `v1,` and the base64 HMAC-SHA256 of ' +
            '`{webhook-id}.{webhook-timestamp}.{body}`, keyed with the base64-decoded part of the secret after `whsec_`. ' +
            'Answer with any 2xx within 15 seconds. Anything else is retried 7 times over about 27 hours, with the same `webhook-id`; ' +
            'an endpoint is turned off after 5 events in a row fail every attempt. Events can arrive more than once and out of order.',
          parameters: [
            { name: 'webhook-id', in: 'header', required: true, schema: { type: 'string' }, description: 'The event’s id. Use it to drop repeats.' },
            { name: 'webhook-timestamp', in: 'header', required: true, schema: { type: 'string' }, description: 'Unix seconds when this attempt was signed.' },
            { name: 'webhook-signature', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: body(ref('WebhookEvent')),
          responses: { '200': { description: 'Received. Any 2xx will do.' } },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'An Eavesy API key (`nt_…`) or an MCP OAuth access token.' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: ['invalid_request', 'unauthorized', 'insufficient_scope', 'not_found', 'method_not_allowed', 'conflict', 'rate_limited', 'internal_error'] },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['error'],
        },
        Account: {
          type: 'object',
          properties: {
            email: { type: ['string', 'null'] },
            name: { type: ['string', 'null'] },
            connection: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                access: { type: 'array', items: { type: 'string', enum: ['read', 'write'] } },
                kind: { type: 'string', enum: ['token', 'oauth'] },
                created_at: { type: 'string', format: 'date-time' },
                expires_at: { type: ['string', 'null'], format: 'date-time' },
              },
            },
          },
        },
        Project: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            about: { type: 'string' },
            terms: { type: 'array', items: { type: 'string' } },
            people: { type: ['string', 'null'] },
            recordings: { type: 'integer' },
          },
        },
        Item: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ITEM_KINDS, description: '`meeting` is any recording, not only calls.' },
            title: { type: 'string' },
            excerpt: { type: ['string', 'null'] },
            project: { type: ['string', 'null'] },
            created_at: { type: 'string', format: 'date-time', description: 'When it was recorded or captured.' },
            duration_sec: { type: ['number', 'null'] },
            url: { type: ['string', 'null'], description: 'Where to open it in Eavesy.' },
            score: { type: 'number', description: 'Search only: 1 for a word match, lower for a match by meaning.' },
          },
          required: ['id', 'kind', 'title', 'excerpt', 'project', 'created_at', 'duration_sec', 'url'],
        },
        ItemList: { type: 'object', properties: { items: { type: 'array', items: ref('Item') } }, required: ['items'] },
        ItemDetail: {
          type: 'object',
          description: 'An item in full. The fields beyond `id`, `kind` and `title` depend on the kind.',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ITEM_KINDS },
            title: { type: 'string' },
            description: { type: ['string', 'null'], description: 'Recording.' },
            started_at: { type: 'string', format: 'date-time', description: 'Recording.' },
            created_at: { type: 'string', format: 'date-time', description: 'Dictation or capture.' },
            duration_sec: { type: ['number', 'null'] },
            summary: {
              description: 'Recording: the summary, or your own Markdown if you replaced it.',
              oneOf: [{ type: 'null' }, { type: 'string' }, ref('Summary')],
            },
            notes: { type: ['string', 'null'], description: 'Recording: what you wrote about it yourself.' },
            project: { type: ['string', 'null'] },
            transcript: { type: ['string', 'null'] },
            text: { type: ['string', 'null'], description: 'Dictation, note or capture: its text.' },
            content_type: { type: 'string', description: 'Capture.' },
            bytes: { type: 'integer', description: 'Capture.' },
            url: { type: ['string', 'null'] },
          },
          required: ['id', 'kind', 'title'],
          additionalProperties: true,
        },
        Summary: {
          type: 'object',
          properties: {
            tldr: { type: 'string' },
            decisions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } },
            action_items: { type: 'array', items: { type: 'object' } },
            follow_ups: { type: 'array', items: { type: 'object' } },
            open_questions: { type: 'array', items: { type: 'object' } },
            topics: { type: 'array', items: {} },
            mentions: { type: 'array', items: {} },
          },
        },
        ActionItem: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'Its place in the recording’s list; the update takes it.' },
            text: { type: 'string' },
            owner: { type: 'string' },
            due: { type: 'string' },
            completed: { type: 'boolean' },
            meeting_id: { type: 'string' },
            meeting_title: { type: 'string' },
          },
          required: ['index', 'text', 'completed', 'meeting_id', 'meeting_title'],
        },
        ActionItemUpdate: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            index: { type: 'integer' },
            text: { type: 'string' },
            owner: { type: 'string' },
            due: { type: 'string' },
            completed: { type: 'boolean' },
          },
          required: ['meeting_id', 'index', 'text', 'completed'],
        },
        Webhook: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            url: { type: 'string' },
            description: { type: 'string' },
            events: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS } },
            enabled: { type: 'boolean' },
            disabled_reason: { type: ['string', 'null'] },
            created_at: { type: 'string', format: 'date-time' },
            last_attempt_at: { type: ['string', 'null'], format: 'date-time' },
            last_success_at: { type: ['string', 'null'], format: 'date-time' },
            last_status: { type: ['integer', 'null'] },
            last_error: { type: ['string', 'null'] },
            created_by_key_id: {
              type: ['string', 'null'],
              description: 'The key that added it over the API. It sends only while that key works; null when added in Eavesy settings.',
            },
          },
          required: ['id', 'url', 'description', 'events', 'enabled', 'disabled_reason', 'created_at', 'last_attempt_at', 'last_success_at', 'last_status', 'last_error', 'created_by_key_id'],
        },
        WebhookEvent: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Also sent as `webhook-id`.' },
            type: {
              type: 'string',
              enum: [...WEBHOOK_EVENTS, 'webhook.test'],
              description:
                '`recording.completed`: a recording finished processing (its summary is ready if it has one). ' +
                '`dictation.created`: a dictation was saved. `capture.created`: a note, screenshot, image, video or audio capture was saved. ' +
                '`webhook.test`: sent only by the test call.',
            },
            timestamp: { type: 'string', format: 'date-time' },
            data: {
              type: 'object',
              description: 'The item, as listed. Get the rest from /items/{id}. A test event carries `endpoint_id` and `message` instead.',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: ITEM_KINDS },
                title: { type: 'string' },
                created_at: { type: 'string', format: 'date-time' },
                url: { type: ['string', 'null'] },
              },
            },
          },
          required: ['id', 'type', 'timestamp', 'data'],
        },
      },
    },
  };
}
