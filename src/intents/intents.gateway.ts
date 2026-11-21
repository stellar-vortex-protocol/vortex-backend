import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { Intent } from './intents.types';

/**
 * Payload broadcast for a uniform-clearing-price batch auction event.
 * Emitted alongside the existing per-intent `auction_price` messages when
 * AUCTION_BATCH_MODE_ENABLED is on and a token pair has open intents.
 */
export interface BatchAuctionPricePayload {
  srcToken: string;
  dstToken: string;
  clearingPrice: number;
  intentIds: string[];
  timestamp: number;
}

@WebSocketGateway({ namespace: '/intents', cors: { origin: '*' } })
export class IntentsGateway {
  private readonly logger = new Logger(IntentsGateway.name);

  @WebSocketServer()
  server: Server;

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @MessageBody() data: { srcToken?: string; dstToken?: string },
    @ConnectedSocket() client: Socket,
  ): { event: string; data: unknown } {
    if (data?.srcToken && data?.dstToken) {
      const room = this.pairRoom(data.srcToken, data.dstToken);
      client.join(room);
      return { event: 'subscribed', data: { room } };
    }
    client.join('intents');
    return { event: 'subscribed', data: { room: 'intents' } };
  }

  broadcastIntent(intent: Intent): void {
    this.server?.emit('intent_update', intent);
  }

  broadcastAuctionPrice(intent: Intent, price: number): void {
    this.server?.emit('auction_price', {
      intentId: intent.id,
      srcToken: intent.srcToken,
      dstToken: intent.dstToken,
      price,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast a single uniform clearing price for a batch of same-pair intents.
   * Emitted alongside the per-intent `auction_price` messages so existing
   * consumers keep working unchanged.
   */
  broadcastBatchAuctionPrice(payload: BatchAuctionPricePayload): void {
    this.server?.emit('batch_auction_price', payload);
    this.server
      ?.to(this.pairRoom(payload.srcToken, payload.dstToken))
      .emit('batch_auction_price', payload);
  }

  private pairRoom(srcToken: string, dstToken: string): string {
    return `pair:${srcToken}:${dstToken}`;
  }
}
