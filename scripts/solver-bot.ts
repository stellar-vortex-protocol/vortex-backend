import WebSocket from 'ws';

/**
 * Minimal solver bot demonstrating how to subscribe to filtered Dutch-auction
 * price ticks over the IntentsGateway WebSocket.
 *
 * Usage:
 *   SOLVER_WS_URL=ws://localhost:3000/ws \
 *   SOLVER_SRC_TOKEN=0x... SOLVER_DST_TOKEN=0x... \
 *   SOLVER_MAX_DST_AMOUNT=1000000000000000000 \
 *   ts-node scripts/solver-bot.ts
 */

interface AuctionTickFilter {
  srcToken: string;
  dstToken: string;
  maxDstAmount?: string;
}

interface AuctionPriceTick {
  type: 'auction_price';
  intentId: string;
  srcToken: string;
  dstToken: string;
  dstAmount: string;
}

const WS_URL = process.env.SOLVER_WS_URL ?? 'ws://localhost:3000/ws';
const SRC_TOKEN = process.env.SOLVER_SRC_TOKEN;
const DST_TOKEN = process.env.SOLVER_DST_TOKEN;
const MAX_DST_AMOUNT = process.env.SOLVER_MAX_DST_AMOUNT;

function buildFilters(): AuctionTickFilter[] {
  if (!SRC_TOKEN || !DST_TOKEN) {
    // No filters: receive the full, unfiltered auction-tick stream.
    return [];
  }

  const filter: AuctionTickFilter = {
    srcToken: SRC_TOKEN,
    dstToken: DST_TOKEN,
  };
  if (MAX_DST_AMOUNT) {
    filter.maxDstAmount = MAX_DST_AMOUNT;
  }
  return [filter];
}

function main(): void {
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    const filters = buildFilters();
    if (filters.length > 0) {
      ws.send(
        JSON.stringify({
          type: 'subscribe_auction_ticks',
          filters,
        }),
      );
      console.log('Subscribed to filtered auction ticks:', filters);
    } else {
      console.log('No filters configured; receiving all auction ticks.');
    }
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('Received non-JSON frame:', raw.toString());
      return;
    }

    if (typeof msg !== 'object' || msg === null) {
      return;
    }

    const frame = msg as { type?: string };
    if (frame.type === 'error') {
      console.error('Gateway error frame:', msg);
      return;
    }

    if (frame.type === 'auction_price') {
      const tick = msg as AuctionPriceTick;
      console.log(
        `auction_price intent=${tick.intentId} ${tick.srcToken}->${tick.dstToken} dstAmount=${tick.dstAmount}`,
      );
    }
  });

  ws.on('error', (err: Error) => {
    console.error('WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.log('Connection closed.');
  });
}

main();
