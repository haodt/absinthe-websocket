import { Socket, Channel, SocketConnectOption } from "phoenix";

const DEFAULT_CHANNEL = "__absinthe__:control";
const SERVER_SENT_DATA_EVENT = "subscription:data";

type MessagePayload = {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
};

type Subscription = {
  messageId: string;
  subscriptionId: string;
  refId?: number | undefined;
  payload: MessagePayload;
};

/**
 * Absinthe websocket implementation follow apollo protocol.
 *
 * This is mearly for subscription only. Query and mutations are not supported yet.
 *
 * TODO: Publish into a package and ensure its well tested. Should remove the extra variables *_clientOperationId* hack.
 */
export default class AbsintheWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  private socket: Socket;
  private channel: Channel;

  public onopen: () => void = () => {};
  public onclose: () => void = () => {};
  public onerror: (err: Error) => void = () => {};
  public onmessage: ({ data }: { data: string }) => void = () => {};

  /**
   * Store subscription to connect the id from SubscriptionClient's payload
   * with subscrptionId returned from phoenix socket server after subscribe.
   */
  private subscriptions: Subscription[] = [];

  constructor(
    url: string,
    _protocol: string,
    options: Partial<SocketConnectOption>
  ) {
    this.socket = new Socket(url, options);
    this.channel = this.socket.channel(DEFAULT_CHANNEL);

    /**
     * Only listen to message once.
     *
     * If there are 2 channe.push('doc') then there will be 2 messages get pushed back on same topic.
     * Given that both are subscribed into same topic (eg: OrderCreated).
     *
     * This will ensure that in the case multiple subscriptions on same topic, message get filtered
     * and return correctly to the subscriptions via unique subscriptionId.
     */
    this.socket.onMessage(this.receive);

    this.socket.onOpen(() => {
      this.onopen && this.onopen();
    });

    this.socket.onError((err: Error) => {
      this.onerror && this.onerror(err);
    });

    this.connect();
  }

  get readyState() {
    return this.socket.connectionState();
  }

  receive = (message: {
    event: string;
    payload: { result: Record<string, unknown>; subscriptionId: string };
  }) => {
    const {
      event,
      payload: { result, subscriptionId: messageSubscriptionId },
    } = message;
    switch (event) {
      case SERVER_SENT_DATA_EVENT:
        this.subscriptions.forEach(({ messageId, subscriptionId }) => {
          if (messageSubscriptionId === subscriptionId) {
            this.onmessage({
              data: JSON.stringify({
                id: messageId,
                payload: result,
                type: "data",
              }),
            });
          }
        });
        break;
    }
  };

  send(data: string) {
    const message = JSON.parse(data);
    const { id, payload, type } = message;
    // Follow this https://github.com/apollographql/subscriptions-transport-ws/blob/0ce7a1e1eb687fe51214483e4735f50a2f2d5c79/PROTOCOL.md

    switch (type) {
      case "connection_init":
        /**
         * Reconnect should resubscribe docs
         */
        this.subscriptions.forEach((subscription) => {
          this.channel.push("doc", {
            operation: subscription.payload.operationName,
            query: subscription.payload.query,
            variables: {
              _clientOperationId: subscription.messageId, // Work-around to make sure that all ops will return a unique subscriptionId
              ...subscription.payload.variables,
            },
          });
        });
        break;
      case "stop":
        this.stopListenToServer(id);
        break;
      case "start":
        this.channel
          .push("doc", {
            operation: payload.operationName,
            query: payload.query,
            variables: {
              _clientOperationId: id, // Work-around to make sure that all ops will return a unique subscriptionId
              ...payload.variables,
            },
          })
          .receive("ok", ({ subscriptionId }: { subscriptionId: string }) => {
            this.listenToServer({
              messageId: id,
              subscriptionId,
              payload,
            });
          })
          .receive("error", console.error)
          .receive("timeout", console.error);
        break;
    }
  }

  close(code: number | undefined, reason: string) {
    this.socket.disconnect(this.onclose, code, reason);
  }

  private stopListenToServer = (messageId: string) => {
    const index = this.subscriptions.findIndex(
      (subscription) => subscription.messageId === messageId
    );

    if (index >= 0) {
      const subscription = this.subscriptions[index];
      this.socket.off([subscription.refId?.toString() as string]);

      const subscriptions = this.subscriptions
        .slice(0, index)
        .concat(this.subscriptions.slice(index + 1, this.subscriptions.length));

      this.subscriptions = subscriptions;

      const isStillSubscribed = subscriptions.find(
        (otherSubscription) =>
          otherSubscription.subscriptionId === subscription.subscriptionId
      );

      if (!isStillSubscribed) {
        this.channel.push("unsubscribe", {
          subscriptionId: subscription.subscriptionId,
        });
      }
    }
  };

  private listenToServer = (subscription: Subscription) => {
    this.subscriptions = [...this.subscriptions, subscription];
  };

  private connect() {
    this.socket.connect();

    this.channel
      .join()
      .receive("error", console.error)
      .receive("timeout", console.error);
  }
}
