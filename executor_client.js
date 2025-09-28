// executor_client.js
import fetch from 'node-fetch';

export async function execBuyViaHotExecutor({ swapTransactionBase64 }) {
  const url = process.env.EXECUTOR_URL;
  if (!url) throw new Error("Missing EXECUTOR_URL");
  const res = await fetch(`${url}/buy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ swapTransactionBase64 })
  });
  if (!res.ok) {
    throw new Error(`Executor error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
