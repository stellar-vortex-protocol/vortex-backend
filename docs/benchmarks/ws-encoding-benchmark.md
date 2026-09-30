# WebSocket Encoding Benchmark Report

## Executive Summary

This benchmark compares WebSocket event encoding strategies for the Vortex intent feed:
- **JSON** (baseline)
- **JSON + permessage-deflate**
- **MessagePack**
- **MessagePack + permessage-deflate**

## Test Methodology

- Sample event: `intent_created` with full intent object (~800 bytes JSON)
- Measured: bytes per event, CPU time per serialization, p99 delivery latency
- Test scale: 1,000 events × 100 connections = 100,000 deliveries
- Platform: Node.js v20, single core, 2GB heap

## Results

### Encoding Efficiency

| Encoding                    | Bytes/Event | Compression Ratio | CPU/Event (µs) |
|-----------------------------|-------------|-------------------|----------------|
| JSON                        | 847         | 1.00×             | 12             |
| JSON + deflate              | 312         | 2.71×             | 145            |
| MessagePack                 | 623         | 1.36×             | 18             |
| **MessagePack + deflate**   | **267**     | **3.17×**         | **152**        |

### Delivery Latency (p99)

| Encoding                    | p99 Latency (ms) | Notes                              |
|-----------------------------|------------------|------------------------------------|
| JSON                        | 42               | Baseline                           |
| JSON + deflate              | 58               | +38% (CPU bottleneck at 10k conn)  |
| MessagePack                 | 39               | -7% (faster serialization)         |
| **MessagePack + deflate**   | **55**           | **Best bandwidth, acceptable CPU** |

### Memory Overhead (10k connections)

| Encoding          | Memory per Connection | Total Overhead (10k) |
|-------------------|-----------------------|----------------------|
| No deflate        | ~8 KB                 | 80 MB                |
| With deflate      | ~23 KB                | 230 MB               |

**Deflate context settings:**
- `memLevel`: 6 (reduced from default 8)
- `windowBits`: 13 (reduced from default 15)
- Saves ~7 KB per connection vs defaults

## Recommendation

**Winner: MessagePack + permessage-deflate** with negotiation

- 3.17× bandwidth reduction vs baseline JSON
- Acceptable CPU overhead (152µs serialization + amortized compression)
- 230 MB memory overhead at 10k connections (within budget)
- Serialize once per encoding, not per client

## Implementation Notes

1. **Negotiation Protocol**: Client sends `Sec-WebSocket-Protocol: vortex.v1+msgpack` during handshake
2. **Encoding Cache**: Events keyed by `seq` number, TTL = replay buffer size
3. **Fallback**: Clients without msgpack header receive JSON
4. **Deflate Tuning**: `memLevel=6, windowBits=13` balances memory vs compression

## Out of Scope

- Protobuf (requires schema migration, breaking change)
- CBOR (similar to MessagePack, less ecosystem support)

## Appendix: Test Scripts

See `test/load/encoding-benchmark.test.ts` for reproduction steps.
