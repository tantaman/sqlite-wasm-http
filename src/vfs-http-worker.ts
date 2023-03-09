// This is the entry point for an HTTP backend thread
// It can serve multiple SQLite worker threads

import LRUCache from 'lru-cache';
import * as VFSHTTP from './vfs-http-types.js';
import { ntoh16 } from './endianness.js';
import { debug } from './vfs-http-types.js';

/*if (typeof WorkerGlobalScope === 'undefined' || !(self instanceof WorkerGlobalScope))
  throw new Error('This script must run in a WebWorker');*/

let options: VFSHTTP.Options;

// This identifies an SQLite worker thread
interface Consumer {
  id: number;
  port: MessagePort;
  shm: SharedArrayBuffer;
  lock: Int32Array;
  buffer: Uint8Array;
};
// The set of sqlite Workers that use this backend
const consumers: Record<string, Consumer> = {};

// The list of known URLs and retrieved pages
interface FileEntry {
  id: number;
  url: string;
  size: bigint;
  pageSize: number | null;
};
const files = new LRUCache<string, FileEntry>({
  max: 32
});

// The entry for a given page can be either the page itself
// or the number of the page that has the parent super-page
let cache: LRUCache<string, Uint8Array | number | Promise<Uint8Array | number>>;

let nextId = 1;

const backendAsyncMethods:
  Record<VFSHTTP.Operation,
    (msg: VFSHTTP.Message, consumer: Consumer) => Promise<number>> = {
  // HTTP is a stateless protocol, so xOpen means verify if the URL is valid
  xOpen: async function (msg) {
    if (files.has(msg.url))
      return 0;

    const fetchOptions = { ...options.fetchOptions };
    if (!fetchOptions.method) fetchOptions.method = 'HEAD';
    if (!fetchOptions.headers) fetchOptions.headers = {};
    const head = await fetch(msg.url, fetchOptions);
    if (head.headers.get('Accept-Ranges') !== 'bytes') {
      console.warn(`Server for ${msg.url} does not advertise 'Accept-Ranges'. ` +
        'If the server supports it, in order to remove this message, add "Accept-Ranges: bytes". ' +
        'Additionally, if using CORS, add "Access-Control-Expose-Headers: *".');
    }
    files.set(msg.url, {
      url: msg.url,
      id: nextId++,
      size: BigInt(head.headers.get('Content-Length')),
      // This will be determined on the first read
      pageSize: null
    });

    return 0;
  },

  // There is no real difference between xOpen and xAccess, only the semantics differ
  xAccess: async function (msg, consumer) {
    const result = new Uint32Array(consumer.shm, 0, 1);
    try {
      const r = await backendAsyncMethods.xOpen(msg, consumer);
      if (r === 0) {
        result[0] = 1;
      } else {
        result[0] = 0;
      }
    } catch {
      result[0] = 0;
    }

    return 0;
  },

  xRead: async function (msg, consumer) {
    const entry = files.get(msg.url);

    if (!entry)
      throw new Error(`File ${msg.url} not open`);

    if (!entry.pageSize) {
      // Determine the page size if we don't know it
      // It is in two big-endian bytes at offset 16 in what is always the first page
      entry.pageSize = 1024;
      const pageDataBuffer = new ArrayBuffer(2);
      const r = await backendAsyncMethods.xRead({ msg: 'xRead', url: msg.url, offset: BigInt(16), n: 2 },
        { buffer: new Uint8Array(pageDataBuffer) } as Consumer);
      const pageData = new Uint16Array(pageDataBuffer);
      if (r !== 0)
        return r;
      ntoh16(pageData);
      entry.pageSize = pageData[0];
      if (entry.pageSize != 1024) {
        // If the page size is not 1024 we can't keep this "page" in the cache
        console.warn(`Page size for ${msg.url} is ${entry.pageSize}, recommended size is 1024`);
        cache.delete(entry.id + '|0');
      }
      if (entry.pageSize > options.maxPageSize)
        throw new Error(`${entry.pageSize} is over the maximum configured ${options.maxPageSize}`);
    }

    const pageSize = BigInt(entry.pageSize);
    const len = BigInt(msg.n);
    const page = msg.offset / pageSize;
    if (page * pageSize !== msg.offset)
      console.warn(`Read chunk ${msg.offset} is not page-aligned`);
    let pageStart = page * pageSize;
    if (pageStart + pageSize < msg.offset + len)
      throw new Error(`Read chunk ${msg.offset}:${msg.n} spans across a page-boundary`);

    const cacheId = entry.id + '|' + page;
    let data = cache.get(cacheId);
    if (data instanceof Promise)
      // This means that another thread has requested this segment
      data = await data;

    if (typeof data === 'number') {
      // This page is present as a segment of a super-page
      pageStart = BigInt(data) * pageSize;
      data = cache.get(entry.id + '|' + data) as Uint8Array;

    } else if (typeof data === 'undefined') {
      debug['cache'](`cache miss for ${msg.url}:${page}`);

      let chunkSize = entry.pageSize;
      // If the previous page is in the cache, we double the page size
      // This was the original page merging algorithm implemented by @phiresky
      let prev = page > 0 && cache.get(entry.id + '|' + (Number(page) - 1));
      if (prev) {
        if (prev instanceof Promise)
          prev = await prev;
        if (typeof prev === 'number')
          prev = cache.get(entry.id + '|' + prev) as Uint8Array;
        chunkSize = prev.byteLength * 2;
        debug['cache'](`downloading super page of size ${chunkSize}`);
      }
      const pages = chunkSize / entry.pageSize;

      // Downloading a new segment
      const fetchOptions = {...options.fetchOptions};
      if (!fetchOptions.method) fetchOptions.method = 'GET';
      if (!fetchOptions.headers) fetchOptions.headers = {};
      fetchOptions.headers['Range'] = `bytes=${pageStart}-${pageStart + BigInt(chunkSize - 1)}`;
      const resp = fetch(msg.url, fetchOptions)
        .then((r) => r.arrayBuffer())
        .then((r) => new Uint8Array(r));
      // We synchronously set a Promise in the cache in case another thread
      // tries to read the same segment
      cache.set(cacheId, resp);
      // These point to the parent super-page and resolve at the same time as resp
      for (let i = Number(page) + 1; i < Number(page) + pages; i++) {
        cache.set(entry.id + '|' + i, resp.then(() => Number(page)));
      }

      data = await resp;
      if (!(data instanceof Uint8Array) || data.length === 0)
        throw new Error(`Invalid HTTP response received: ${JSON.stringify(resp)}`);

      // In case of a multiple-page segment, this is the parent super-page
      cache.set(cacheId, data);

      // These point to the parent super-page
      for (let i = Number(page) + 1; i < Number(page) + pages; i++) {
        cache.set(entry.id + '|' + i, Number(page));
      }
    } else {
      debug['cache'](`cache hit for ${msg.url}:${page}`);
    }

    const pageOffset = Number(msg.offset - pageStart);
    consumer.buffer.set(data.subarray(pageOffset, pageOffset + msg.n));
    return 0;
  },

  // This is cached
  xFilesize: async function (msg, consumer) {
    const entry = files.get(msg.url);
    if (!entry)
      throw new Error(`File ${msg.fid} not open`);

    const out = new BigInt64Array(consumer.shm, 0, 1);
    out[0] = entry.size;
    return 0;
  }
};

async function workMessage({ data }) {
  debug['threads']('Received new work message', this, data);
  let r;
  try {
    r = await backendAsyncMethods[data.msg](data, this);

    debug['threads']('operation successful', this, r);
    Atomics.store(this.lock, 0, r);
  } catch (e) {
    console.error(e);
    Atomics.store(this.lock, 0, 1);
  }
  Atomics.notify(this.lock, 0);
}

globalThis.onmessage = ({ data }) => {
  debug['threads']('Received new control message', data);
  switch (data.msg) {
    case 'handshake':
      const shm = new SharedArrayBuffer(options.maxPageSize + Int32Array.BYTES_PER_ELEMENT);
      const lock = new Int32Array(shm, options.maxPageSize);
      const buffer = new Uint8Array(shm, 0, options.maxPageSize);
      lock[0] = 0xffff;
      consumers[data.id] = { id: data.id, port: data.port, shm, lock, buffer };
      postMessage({ msg: 'ack', id: data.id, shm, lock });
      data.port.onmessage = workMessage.bind(consumers[data.id]);
      break;
    case 'init':
      options = data.options;
      cache = new LRUCache<string, Uint8Array>({
        maxSize: options.cacheSize * 1024,
        sizeCalculation: (value) => value.byteLength ?? 4
      });
      break;
    case 'close':
      postMessage({ msg: 'ack' });
      close();
      break;
    default:
      throw new Error(`Invalid message received by backend: ${data}`);
  }
};
