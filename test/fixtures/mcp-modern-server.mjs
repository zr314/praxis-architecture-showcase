import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2026-07-28'
const mode = process.argv[2] ?? 'basic'
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let listRequests = 0
let callRequests = 0

if (mode === 'descendant') {
  const marker = process.env.PRAXIS_MCP_DESCENDANT_MARKER
  const pidFile = process.env.PRAXIS_MCP_DESCENDANT_PID
  if (!marker || !pidFile) throw new Error('Missing descendant fixture paths.')
  const script = [
    "const { writeFileSync } = require('node:fs')",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 1_000)`,
    'setInterval(() => {}, 1_000)',
  ].join(';')
  spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (mode === 'oversized-frame') {
    process.stdout.write('x'.repeat(2_048))
    return
  }
  if (mode === 'stdout-contamination') {
    process.stdout.write('this is not json-rpc\n')
    return
  }
  if (request.method === 'server/discover') {
    if (request.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== PROTOCOL_VERSION) {
      respondError(request.id, -32022, 'Unsupported protocol version')
      return
    }
    if (mode === 'unknown-response') {
      respond(99_999, { resultType: 'complete' })
      return
    }
    if (mode === 'stderr-flood') process.stderr.write('x'.repeat(4_096))
    if (mode === 'stderr-split') {
      const diagnostic = Buffer.from('诊断中文', 'utf8')
      process.stderr.write(diagnostic.subarray(0, 4))
      setTimeout(() => {
        process.stderr.write(diagnostic.subarray(4))
        respondDiscover(request)
      }, 5)
      return
    }
    respondDiscover(request)
    return
  }
  if (request.method === 'notifications/cancelled') {
    if (isModernRequest(request)) {
      process.stderr.write(`cancelled:${request.params.requestId}\n`)
    }
    return
  }
  if (!isModernRequest(request)) {
    respondError(request.id, -32022, 'Unsupported protocol version')
    return
  }
  if (request.method === 'tools/list') {
    listRequests += 1
    const cursor = request.params?.cursor
    const tools =
      mode === 'hostile-schema'
        ? [
            {
              ...tool('hostile'),
              inputSchema: {
                type: 'object',
                properties: {
                  value: { $ref: 'https://attacker.invalid/schema.json' },
                },
              },
            },
          ]
        : mode === 'recursive-schema'
          ? [{ ...tool('recursive'), inputSchema: deepSchema(40) }]
          : mode === 'duplicate-tools'
            ? [tool('duplicate'), tool('duplicate')]
            : mode === 'paginated'
              ? cursor === 'second-page'
                ? [tool('second')]
                : [tool('first')]
              : mode === 'list-change'
                ? [tool(listRequests === 1 ? 'first' : 'second')]
                : [tool('echo')]
    respond(request.id, {
      resultType: 'complete',
      tools,
      ...(mode === 'paginated' && cursor !== 'second-page' ? { nextCursor: 'second-page' } : {}),
      ttlMs: 0,
      cacheScope: 'private',
    })
    if (mode === 'list-change' && listRequests === 1) {
      setTimeout(
        () =>
          notify('notifications/tools/list_changed', {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            },
          }),
        5,
      )
    }
    if (mode === 'unsupported-request') {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'server-request-1',
          method: 'resources/list',
          params: {},
        })}\n`,
      )
    }
  } else if (request.method === 'tools/call') {
    callRequests += 1
    if (mode === 'timeout') return
    if (mode === 'late-response' && callRequests === 1) {
      setTimeout(() => respondTool(request), 150)
      return
    }
    if (mode === 'progress') {
      writeSplit({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: request.params?._meta?.progressToken ?? 'missing',
          progress: 1,
          total: 1,
          message: '处理中',
        },
      })
      setTimeout(() => respondTool(request), 10)
    } else if (mode === 'invalid-output') {
      respond(request.id, {
        resultType: 'complete',
        content: [{ type: 'text', text: 'invalid structured output' }],
        structuredContent: { value: 42 },
        isError: false,
      })
    } else if (mode === 'duplicate-response') {
      respondTool(request)
      respondTool(request)
    } else {
      respondTool(request)
    }
  } else if (request.method === 'shutdown') {
    respond(request.id, { resultType: 'complete' })
  } else {
    respondError(request.id, -32601, 'Method not found')
  }
})

function isModernRequest(request) {
  return request.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === PROTOCOL_VERSION
}

function respondDiscover(request) {
  respond(request.id, {
    resultType: 'complete',
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: { tools: { listChanged: mode === 'list-change' } },
    ttlMs: 0,
    cacheScope: 'private',
    _meta: {
      'io.modelcontextprotocol/serverInfo': {
        name: 'praxis-modern-fixture',
        version: '1.0.0',
      },
    },
  })
}

function tool(name) {
  return {
    name,
    description: `Runs ${name}.`,
    inputSchema: { type: 'object' },
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  }
}

function deepSchema(depth) {
  let schema = { type: 'string' }
  for (let index = 0; index < depth; index += 1) {
    schema = { type: 'object', properties: { value: schema } }
  }
  return schema
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function respondTool(request) {
  respond(request.id, {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }],
    structuredContent: request.params.arguments,
    isError: false,
  })
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

function writeSplit(message) {
  const encoded = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
  const marker = Buffer.from('处', 'utf8')
  const markerIndex = encoded.indexOf(marker)
  const split = markerIndex < 0 ? Math.floor(encoded.length / 2) : markerIndex + 1
  process.stdout.write(encoded.subarray(0, split))
  setTimeout(() => process.stdout.write(encoded.subarray(split)), 5)
}
