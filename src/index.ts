import { EventEmitter } from 'events'
import net, { Socket } from 'net'

import BrowserWebSocket from 'isomorphic-ws'
import NodeWebSocket from 'ws'

import { encoder, decoder } from './buffer'
import { Agent } from 'http'

export const relayEvent = Symbol('relay')
export const isNode = BrowserWebSocket === NodeWebSocket

const WebSocket = isNode ? NodeWebSocket : class extends EventEmitter {
  ws: BrowserWebSocket

  constructor(address: string, ...args: any[]) {
    super()

    const ws = new BrowserWebSocket(address)
    this.ws = ws

    ws.onopen = () => this.emit('open')
    ws.onmessage = async ({ data }) => this.emit('message', Buffer.from(await new Response(data as unknown as InstanceType<typeof Blob>).arrayBuffer()))
    ws.onerror = () => this.emit('error')
    ws.onclose = () => this.emit('close')
  }

  get readyState() {
    return this.ws.readyState
  }

  send(data: Buffer) {
    this.ws.send(data)
  }

  close(code?: number, data?: string) {
    this.ws.close(code, data)
  }
}

class NiceEventEmitter extends EventEmitter {
  emit(eventName: string | symbol, ...params: any[]) {
    super.emit(eventName, ...params)
    super.emit(relayEvent, eventName, ...params)
    return true
  }
}

type EventMap = {
  [relayEvent]: any[]
  close: [number?, string?]
  open: []
  _error: [Error]
  error: [Error]
  live: []
  msg: [any]
  heartbeat: [number]
  timeout: []
  DANMU_MSG: [object]
  message: [Buffer]
}

interface Live {
  on<E extends keyof EventMap>(eventName: E, listener: (...data: EventMap[E]) => void): any
  once<E extends keyof EventMap>(eventName: E, listener: (...data: EventMap[E]) => void): any
  emit<E extends keyof EventMap>(eventName: E, ...data: EventMap[E]): boolean
}

class Live extends NiceEventEmitter {
  roomid: number
  online: number
  live: boolean
  closed: boolean
  timeout: ReturnType<typeof setTimeout>

  send: (data: Buffer) => void
  close: () => void

  constructor(roomid: number, { send, close, protover, key }: { send: (data: Buffer) => void, close: () => void, protover: 1 | 2, key?: string }) {
    if (typeof roomid !== 'number' || Number.isNaN(roomid)) {
      throw new Error(`roomid ${roomid} must be Number not NaN`)
    }

    super()
    this.roomid = roomid
    this.online = 0
    this.live = false
    this.closed = false
    this.timeout = setTimeout(() => { }, 0)

    this.send = send
    this.close = () => {
      this.closed = true
      close()
    }

    this.on('message', async buffer => {
      const packs = await decoder(buffer)
      packs.forEach(pack => {
        const { type, data } = pack
        if (type === 'welcome') {
          this.live = true
          this.emit('live')
          this.send(encoder('heartbeat'))
        }
        if (type === 'heartbeat') {
          this.online = data
          clearTimeout(this.timeout)
          this.timeout = setTimeout(() => this.heartbeat(), 1000 * 30)
          this.emit('heartbeat', this.online)
        }
        if (type === 'message') {
          this.emit('msg', data)
          const cmd = data.cmd || (data.msg && data.msg.cmd)
          if (cmd) {
            if (cmd.includes('DANMU_MSG')) {
              this.emit('DANMU_MSG', data)
            } else {
              this.emit(cmd, data)
            }
          }
        }
      })
    })

    this.on('open', () => {
      const hi: { uid: number, roomid: number, protover: number, platform: string, clientver: string, type: number, key?: string } = { uid: 0, roomid, protover, platform: 'web', clientver: '1.10.6', type: 2 }
      if (key) {
        hi.key = key
      }
      const buf = encoder('join', hi)
      this.send(buf)
    })

    this.on('close', () => {
      clearTimeout(this.timeout)
    })

    this.on('_error', error => {
      this.close()
      this.emit('error', error)
    })
  }

  heartbeat() {
    this.send(encoder('heartbeat'))
  }

  getOnline() {
    this.heartbeat()
    return new Promise<number>(resolve => this.once('heartbeat', resolve))
  }
}

export class LiveWS extends Live {
  ws: InstanceType<typeof WebSocket>

  constructor(roomid: number, { address = 'wss://broadcastlv.chat.bilibili.com/sub', protover = 2, key, agent }: { address?: string, protover?: 1 | 2, key?: string, agent?: Agent } = {}) {
    const ws = new WebSocket(address, { agent })
    const send = (data: Buffer) => {
      if (ws.readyState === 1) {
        ws.send(data)
      }
    }
    const close = () => this.ws.close()

    super(roomid, { send, close, protover, key })

    ws.on('open', (...params) => this.emit('open', ...params))
    ws.on('message', data => this.emit('message', data as Buffer))
    ws.on('close', (code, reason) => this.emit('close', code, reason))
    ws.on('error', error => this.emit('_error', error))

    this.ws = ws
  }
}

export class LiveTCP extends Live {
  socket: Socket
  buffer: Buffer

  constructor(roomid: number, { host = 'broadcastlv.chat.bilibili.com', port = 2243, protover = 2, key }: { host?: string, port?: number, protover?: 1 | 2, key?: string } = {}) {
    const socket = net.connect(port, host)
    const send = (data: Buffer) => {
      socket.write(data)
    }
    const close = () => this.socket.end()

    super(roomid, { send, close, protover, key })

    this.buffer = Buffer.alloc(0)

    socket.on('ready', () => this.emit('open'))
    socket.on('close', () => this.emit('close'))
    socket.on('error', (...params) => this.emit('_error', ...params))
    socket.on('data', buffer => {
      this.buffer = Buffer.concat([this.buffer, buffer])
      this.splitBuffer()
    })
    this.socket = socket
  }

  splitBuffer() {
    while (this.buffer.length >= 4 && this.buffer.readInt32BE(0) <= this.buffer.length) {
      const size = this.buffer.readInt32BE(0)
      const pack = this.buffer.slice(0, size)
      this.buffer = this.buffer.slice(size)
      this.emit('message', pack)
    }
  }
}



const keepLive = (Base: typeof LiveWS | typeof LiveTCP) => class extends EventEmitter {
  params: [number, any?]
  closed: boolean
  interval: number
  timeout: number
  connection: InstanceType<typeof Base>

  constructor(...params: ConstructorParameters<typeof Base>) {
    super()
    this.params = params
    this.closed = false
    this.interval = 100
    this.timeout = 45 * 1000
    this.connection = new Base(...this.params)
    this.connect(false)
  }

  connect(reconnect = true) {
    if (reconnect) {
      this.connection = new Base(...this.params)
    }
    const connection = this.connection

    let timeout = setTimeout(() => {
      connection.close()
      connection.emit('timeout')
    }, this.timeout)

    connection.on(relayEvent, (eventName: string, ...params: any[]) => {
      if (eventName !== 'error') {
        this.emit(eventName, ...params)
      }
    })

    connection.on('error', (e: any) => this.emit('e', e))
    connection.on('close', () => {
      if (!this.closed) {
        setTimeout(() => this.connect(), this.interval)
      }
    })

    connection.on('heartbeat', () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        connection.close()
        connection.emit('timeout')
      }, this.timeout)
    })

    connection.on('close', () => {
      clearTimeout(timeout)
    })
  }

  get online() {
    return this.connection.online
  }

  get roomid() {
    return this.connection.roomid
  }

  close() {
    this.closed = true
    this.connection.close()
  }

  heartbeat() {
    return this.connection.heartbeat()
  }

  getOnline() {
    return this.connection.getOnline()
  }

  send(data: Buffer) {
    return this.connection.send(data)
  }
}


export interface KeepLiveWS {
  on<E extends keyof EventMap>(eventName: E, listener: (...data: EventMap[E]) => void): any
  once<E extends keyof EventMap>(eventName: E, listener: (...data: EventMap[E]) => void): any
  emit<E extends keyof EventMap>(eventName: E, ...data: EventMap[E]): boolean
}

export interface KeepLiveTCP {
  on<E extends keyof EventMap>(eventName: E, listener: (...data: EventMap[E]) => void): any
  once<E extends keyof EventMap>(eventName: E, listener: (...data: EventMap[E]) => void): any
  emit<E extends keyof EventMap>(eventName: E, ...data: EventMap[E]): boolean
}

export class KeepLiveWS extends keepLive(LiveWS) { }
export class KeepLiveTCP extends keepLive(LiveTCP) { }
