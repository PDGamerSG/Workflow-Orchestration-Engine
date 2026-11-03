"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { PublicConnection, ProviderInfo } from "@/lib/types";
import { ConfirmButton } from "./confirm-button";

export function ConnectionManager() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [providerId, setProviderId] = useState("openai");
  const [name, setName] = useState("");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [apiKey, setApiKey] = useState("");
  const [rpm, setRpm] = useState(30);
  const [inputPerM, setInputPerM] = useState("");
  const [outputPerM, setOutputPerM] = useState("");
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const provider = providers.find((item) => item.id === providerId);

  useEffect(() => {
    let alive = true;
    Promise.all([api.providers(), api.connections()]).then(
      ([catalog, saved]) => {
        if (alive) {
          setProviders(catalog);
          setConnections(saved);
          setLoading(false);
        }
      },
      (error: Error) => {
        if (alive) {
          setError(error.message);
          setLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  function choose(id: string) {
    setProviderId(id);
    const selected = providers.find((item) => item.id === id);
    if (selected) {
      setModel(selected.model);
      setRpm(selected.rpm);
      setSearchEnabled(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const connection = await api.addConnection({
        name: name.trim() || `${provider?.name ?? providerId} connection`,
        provider: providerId,
        model: model.trim(),
        apiKey,
        rpm,
        inputPerM: Number(inputPerM) || 0,
        outputPerM: Number(outputPerM) || 0,
        searchEnabled,
      });
      setConnections((current) => [connection, ...current]);
      setApiKey("");
      setName("");
      setNotice(
        `${connection.name} is connected. You can select it in the playground.`,
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not save the connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(connection: PublicConnection) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.deleteConnection(connection.id);
      setConnections((current) =>
        current.filter((item) => item.id !== connection.id),
      );
      setNotice(`${connection.name} and its encrypted key were removed.`);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not remove the connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="privacy-note">
        <span className="privacy-symbol" aria-hidden="true">
          ⌑
        </span>
        <div>
          <strong>Private to this browser workspace</strong>
          <p>
            Your key is sent over HTTPS, validated with the provider, and saved
            with authenticated encryption. Validation makes one small API call.
            Clearing your workspace cookie loses access to these connections.
          </p>
        </div>
      </div>
      {notice && (
        <p className="success-box" role="status">
          {notice} <Link href="/playground">Open playground</Link>
        </p>
      )}
      {error && (
        <p className="error-box" role="alert" style={{ marginBottom: 20 }}>
          {error}
        </p>
      )}
      <div className="connections-layout">
        <form className="panel connection-form" onSubmit={save}>
          <h2>Add a connection</h2>
          <p className="hint">
            Your key stays out of browser storage, run exports and event logs.
          </p>
          <label className="field-label" htmlFor="provider">
            Provider
          </label>
          <select
            id="provider"
            className="input"
            value={providerId}
            onChange={(event) => choose(event.target.value)}
            disabled={loading || busy}
          >
            {providers.length ? (
              providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            ) : (
              <option value="openai">
                {loading ? "Loading providers…" : "Providers unavailable"}
              </option>
            )}
          </select>
          <label className="field-label" htmlFor="connection-name">
            Connection name <span className="hint">(optional)</span>
          </label>
          <input
            id="connection-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            placeholder="My development key"
          />
          <div className="flex items-baseline justify-between gap-3">
            <label className="field-label" htmlFor="api-key">
              API key
            </label>
            {provider && (
              <a
                className="hint text-link"
                href={provider.keyUrl}
                target="_blank"
                rel="noreferrer"
              >
                Get a key ↗
              </a>
            )}
          </div>
          <input
            id="api-key"
            type="password"
            className="input mono"
            required
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste your provider API key"
            maxLength={4096}
          />
          <label className="field-label" htmlFor="model">
            Model ID
          </label>
          <input
            id="model"
            className="input mono"
            value={model}
            required
            maxLength={150}
            onChange={(event) => setModel(event.target.value)}
          />
          <p className="hint">
            Use the exact model ID available to your provider account.
          </p>
          <label className="field-label" htmlFor="rpm">
            Requests per minute
          </label>
          <input
            id="rpm"
            className="input"
            type="number"
            min={1}
            max={60000}
            value={rpm}
            onChange={(event) => setRpm(Number(event.target.value))}
            required
          />
          {provider?.search && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={searchEnabled}
                onChange={(event) => setSearchEnabled(event.target.checked)}
              />
              Enable Google Search grounding for research runs
            </label>
          )}
          <details className="advanced-settings">
            <summary>Token prices for cost estimates</summary>
            <p className="hint">
              Optional USD per million tokens. Verify your provider’s current
              rates. Without prices, use a token budget.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label" htmlFor="input-price">
                  Input / 1M
                </label>
                <input
                  id="input-price"
                  className="input"
                  type="number"
                  min="0"
                  step="0.001"
                  value={inputPerM}
                  onChange={(event) => setInputPerM(event.target.value)}
                  placeholder="Not set"
                />
              </div>
              <div>
                <label className="field-label" htmlFor="output-price">
                  Output / 1M
                </label>
                <input
                  id="output-price"
                  className="input"
                  type="number"
                  min="0"
                  step="0.001"
                  value={outputPerM}
                  onChange={(event) => setOutputPerM(event.target.value)}
                  placeholder="Not set"
                />
              </div>
            </div>
          </details>
          <button
            className="button"
            type="submit"
            disabled={busy || loading || !providers.length}
          >
            {busy ? "Validating connection…" : "Validate & save connection"}
          </button>
        </form>
        <aside className="saved-connections">
          <h2>Your connections</h2>
          {loading ? (
            <p className="hint">Loading saved connections…</p>
          ) : connections.length === 0 ? (
            <div className="empty-state">
              <span className="lamp" data-state="pending" />
              <h3>No provider connected yet</h3>
              <p>
                Add your own key to run real models, or explore the demo for
                free.
              </p>
              <Link className="text-link" href="/playground">
                Try the playground
              </Link>
            </div>
          ) : (
            <div className="connection-list">
              {connections.map((connection) => (
                <article className="panel saved-connection" key={connection.id}>
                  <div className="flex items-center gap-2">
                    <span className="lamp" data-state="succeeded" />
                    <h3>{connection.name}</h3>
                  </div>
                  <p className="mono">
                    {connection.provider} / {connection.model}
                  </p>
                  <p className="hint">
                    {connection.rpm} requests/min · Key encrypted
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      className="button"
                      data-variant="quiet"
                      data-size="small"
                      href={`/playground?connection=${connection.id}`}
                    >
                      Use connection
                    </Link>
                    <ConfirmButton
                      label="Remove key"
                      confirmLabel="Remove permanently"
                      disabled={busy}
                      onConfirm={() => remove(connection)}
                    />
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="connection-help">
            <h3>A key is not a subscription login</h3>
            <p>
              ChatGPT and Claude subscriptions do not automatically include API
              credit. Use a key from your provider’s API console.
            </p>
            <p>
              Local Pi, Claude Code and Codex authentication is configured on
              your own machine.
            </p>
            <Link className="text-link" href="/architecture#agents">
              How local adapters work
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}
