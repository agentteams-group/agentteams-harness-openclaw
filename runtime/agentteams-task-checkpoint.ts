// SDK persistence only: the common bridge owns delivery acknowledgement shape.
const checkpointType = "agentteams-task-middleware";

type Bridge = (request: Record<string, unknown>) => Promise<any>;
type DeliveryFrame = {
  deliveryRoom?: string;
  deliveryFacts?: string[];
  deliveryAcknowledgements?: Record<string, string>;
};
type Manager = {
  getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
  appendCustomEntryAsync(type: string, data: unknown): Promise<string>;
  appendMessageAsync(message: unknown): Promise<string>;
  buildSessionContext(): { messages: any[] };
  flushPendingPersistence(): void;
};

export function taskMiddlewareContext(manager: Pick<Manager, "getEntries">): Record<string, unknown> {
  const saved = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === checkpointType).at(-1);
  if (!saved) return {};
  if (!saved.data || typeof saved.data !== "object" || Array.isArray(saved.data)) {
    throw new Error("Native Task middleware checkpoint is invalid");
  }
  return saved.data as Record<string, unknown>;
}

export async function prepareTaskDeliveries(frame: DeliveryFrame | undefined, manager: Pick<Manager, "getEntries">, call: Bridge) {
  if (!frame?.deliveryRoom) return;
  const result = await call({ operation: "delivery_context", middle: taskMiddlewareContext(manager), room: frame.deliveryRoom });
  frame.deliveryFacts = result.facts;
  frame.deliveryAcknowledgements = result.acknowledgements;
}

export async function checkpointTaskDeliveries(frame: DeliveryFrame, context: any, native: {
  manager: Manager; session: any; persist: (write: () => Promise<void>) => Promise<void>;
}, call: Bridge) {
  const facts = frame.deliveryFacts || [];
  if (!facts.length || !Object.keys(frame.deliveryAcknowledgements || {}).length) return;
  const visible = [context.systemPrompt || "", ...(context.messages || []).map((message: any) =>
    typeof message.content === "string" ? message.content : (message.content || []).map((part: any) => part.text || "").join("\n"))];
  if (!facts.every((fact) => visible.some((text) => text.includes(fact)))) return;
  const admitted: any[] = [];
  await native.persist(async () => {
    const key = "agentteams:delivery:" + JSON.stringify(Object.entries(frame.deliveryAcknowledgements || {}).sort());
    let message = native.manager.buildSessionContext().messages.find((message) => message.idempotencyKey === key);
    if (!message) {
      // Persist admitted context with its acknowledgement: an interrupted
      // provider request must not lose the receipt from the next native turn.
      message = { role: "user", content: [{ type: "text", text: facts.join("\n\n") }],
        timestamp: Date.now(), idempotencyKey: key };
      await native.manager.appendMessageAsync(message);
    }
    admitted.push(message);
    const middle = await call({ operation: "ack_delivery_context", middle: taskMiddlewareContext(native.manager),
      acknowledgements: frame.deliveryAcknowledgements });
    await native.manager.appendCustomEntryAsync(checkpointType, middle);
    native.manager.flushPendingPersistence();
  });
  for (const messages of [native.session.agent.state.messages, context.messages]) {
    for (const message of admitted) if (!messages.some((saved: any) => saved.idempotencyKey === message.idempotencyKey)) messages.push(message);
  }
  frame.deliveryAcknowledgements = {};
}
