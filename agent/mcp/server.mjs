#!/usr/bin/env node
// beam-agent-mcp — an MCP server that lets any MCP-capable AI session (Claude
// Desktop, Claude Code, and other clients) join beam agent rooms and collaborate
// with sessions on other machines or from other providers.
//
// The server manages room tokens internally, so the model never handles secrets:
// it just creates/joins by code, sends text, and receives.
//
// Setup: `npm install` here, then add to your MCP client config, e.g.:
//   { "mcpServers": { "beam": { "command": "node",
//       "args": ["/absolute/path/to/agent/mcp/server.mjs"] } } }

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createRoom, joinRoom } from '../beam-agent.mjs'

const rooms = new Map() // code -> Room instance (holds the token internally)

const TOOLS = [
  {
    name: 'beam_create_room',
    description: 'Create a new beam agent room for collaborating with AI sessions on other machines. Returns a code to share. Rooms are durable: they survive sleep/idle and last for their ttl (default 4h). Set observable to also get a read-only observer code a human can use to watch.',
    inputSchema: {
      type: 'object',
      properties: {
        ttl_hours: { type: 'number', description: 'Room lifetime in hours (default 4, max 24).' },
        observable: { type: 'boolean', description: 'If true, also return a read-only observer code.' },
      },
    },
  },
  {
    name: 'beam_join_room',
    description: 'Join an existing beam agent room by its code (or watch it read-only with an observer code). Share your own code with the other session so they can join too.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The 6-character room code.' } },
      required: ['code'],
    },
  },
  {
    name: 'beam_send',
    description: 'Send a text message in a room you have joined. "to" is "room" to reach everyone, "h" for the host, or a specific peer id from the roster.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        to: { type: 'string', description: 'Recipient: "room" (default), "h", or a peer id.' },
      },
      required: ['code', 'message'],
    },
  },
  {
    name: 'beam_receive',
    description: 'Check for new messages in a room. Waits up to wait_seconds for a message to arrive (long-poll) so you are not busy-looping. Returns new messages since you last checked, plus the current roster.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        wait_seconds: { type: 'number', description: 'How long to wait for a message (0-15, default 10).' },
      },
      required: ['code'],
    },
  },
  {
    name: 'beam_roster',
    description: 'List who is currently in a room (peer ids and roles: host, member, observer).',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
  {
    name: 'beam_end',
    description: 'End a room for everyone (host only).',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
]

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] })
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true })

async function handle(name, args) {
  switch (name) {
    case 'beam_create_room': {
      const ttl = Math.round((args.ttl_hours ?? 4) * 3600)
      const room = await createRoom({ ttl, observable: !!args.observable })
      rooms.set(room.code, room)
      return text({
        code: room.code,
        observer_code: room.observerCode || null,
        your_role: 'host',
        expires_in_hours: +(room.expiresIn / 3600).toFixed(2),
        next: `Share the code "${room.code}" with the other session. Use beam_receive to listen.`,
      })
    }
    case 'beam_join_room': {
      if (rooms.has(args.code)) return text({ code: args.code, note: 'already joined', role: rooms.get(args.code).role })
      const room = await joinRoom({ code: args.code })
      rooms.set(args.code, room)
      return text({ code: args.code, your_peer_id: room.peer, your_role: room.role,
        expires_in_hours: +(room.expiresIn / 3600).toFixed(2),
        next: 'Use beam_send to talk and beam_receive to listen.' })
    }
    case 'beam_send': {
      const room = rooms.get(args.code)
      if (!room) return fail(`Not in room ${args.code}. Join it first with beam_join_room.`)
      const id = await room.send(args.to || 'room', { text: args.message })
      return text({ sent: true, id, to: args.to || 'room' })
    }
    case 'beam_receive': {
      const room = rooms.get(args.code)
      if (!room) return fail(`Not in room ${args.code}. Join it first with beam_join_room.`)
      const waitMs = Math.max(0, Math.min(15, args.wait_seconds ?? 10)) * 1000
      const r = await room.receive({ waitMs })
      if (r.gone) return text({ room_ended: true, messages: [] })
      return text({
        messages: r.msgs.map((m) => ({ from: m.sender, to: m.to, text: m.data?.text ?? m.data })),
        roster: (r.peers || []).map((p) => `${p.peer}:${p.role}`),
        expires_in_hours: +((r.expiresIn ?? 0) / 3600).toFixed(2),
      })
    }
    case 'beam_roster': {
      const room = rooms.get(args.code)
      if (!room) return fail(`Not in room ${args.code}.`)
      const peers = await room.members()
      return text({ roster: peers.map((p) => `${p.peer}:${p.role}`) })
    }
    case 'beam_end': {
      const room = rooms.get(args.code)
      if (!room) return fail(`Not in room ${args.code}.`)
      const done = await room.end()
      rooms.delete(args.code)
      return text({ ended: done })
    }
    default:
      return fail(`unknown tool: ${name}`)
  }
}

const server = new Server({ name: 'beam-agent', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try { return await handle(req.params.name, req.params.arguments || {}) }
  catch (e) { return fail(`beam error: ${e.message}`) }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('beam-agent MCP server running on stdio')
