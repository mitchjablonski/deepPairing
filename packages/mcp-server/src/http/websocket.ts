import type { WebSocket } from "ws";

const clients = new Set<WebSocket>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
}

export function removeClient(ws: WebSocket): void {
  clients.delete(ws);
}

export function broadcast(event: any): void {
  const data = JSON.stringify(event);
  for (const client of clients) {
    try {
      if (client.readyState === 1) {
        client.send(data);
      }
    } catch {
      clients.delete(client);
    }
  }
}

export function getClientCount(): number {
  return clients.size;
}
