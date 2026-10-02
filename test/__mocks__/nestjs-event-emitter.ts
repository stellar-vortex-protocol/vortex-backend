/**
 * Jest stand-in for the ESM-only @nestjs/event-emitter package (same pattern
 * as the @nestjs/schedule mock above it: jest's CJS transform cannot parse
 * the package's `export` syntax). The codebase only touches `emit`, which
 * Node's EventEmitter already provides.
 */
import { EventEmitter } from "events";

export class EventEmitter2 extends EventEmitter {}
