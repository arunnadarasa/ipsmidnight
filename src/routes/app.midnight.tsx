import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ExternalLink, Loader2, RefreshCw, Rocket, ShieldCheck, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SectionHeading, Panel } from "@/components/SectionHeading";
import { StatusDot, TruncatedMono } from "@/components/MonoValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FLY_REGIONS } from "@/lib/midnight/shared";
import { checkFlyStack, destroyFlyStack, provisionFlyStack, verifyAnchor } from "@/lib/midnight/fly.functions";
import contractInfo from "@/data/midnight-contract.undeployed.json";
import { ipsCommitment, randomSaltHex } from "@/lib/ips/digest";

const PLACEHOLDER_ADDRESS = "0".repeat(64);

export const Route = createFileRoute("/app/midnight")({
  head: () => ({
    meta: [
      { title: "Midnight network — IPS Console" },
      {
        name: "description",
        content: "Provision a Fly-hosted Midnight Undeployed stack and anchor patient summary commitments.",
      },
      { property: "og:title", content: "Midnight network — IPS Console" },
      { property: "og:description", content: "Fly-hosted node, indexer, and proof server for Undeployed anchoring." },
    ],
  }),
  component: MidnightConsole,
});

function MidnightConsole() {
  const qc = useQueryClient();
  const provision = useServerFn(provisionFlyStack);
  const check = useServerFn(checkFlyStack);
  const destroy = useServerFn(destroyFlyStack);
  const verify = useServerFn(verifyAnchor);

  const [prefix, setPrefix] = useState("");
  const [region, setRegion] = useState<string>("lhr");

  const { data: deployment } = useQuery({
    queryKey: ["fly_deployment"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fly_deployments")
        .select("*")
        .eq("kind", "midnight")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: bundles } = useQuery({
    queryKey: ["ips_bundles_min"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ips_bundles")
        .select("id,title,digest")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: anchors } = useQuery({
    queryKey: ["anchors"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("midnight_anchors")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const health = useQuery({
    queryKey: ["fly_health", deployment?.app_prefix],
    enabled: Boolean(deployment?.app_prefix),
    refetchInterval: 30_000,
    queryFn: () => check({ data: { appPrefix: deployment!.app_prefix } }),
  });

  const doProvision = useMutation({
    mutationFn: () => provision({ data: { appPrefix: prefix, region } }),
    onSuccess: (r) => {
      toast.success(`Stack ${r.appName} provisioning — machines are booting.`);
      void qc.invalidateQueries({ queryKey: ["fly_deployment"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const doDestroy = useMutation({
    mutationFn: () => destroy({ data: { appPrefix: deployment!.app_prefix } }),
    onSuccess: () => {
      toast.success("Stack destroyed");
      void qc.invalidateQueries({ queryKey: ["fly_deployment"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const doVerify = useMutation({
    mutationFn: (anchorId: string) => verify({ data: { anchorId } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Confirmed on the indexer${r.blockHeight ? ` · block #${r.blockHeight}` : ""}`);
      else toast.warning(r.detail);
      void qc.invalidateQueries({ queryKey: ["anchors"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const prepareAnchor = useMutation({
    mutationFn: async (bundle: { id: string; title: string; digest: string | null }) => {
      if (!bundle.digest) throw new Error("That summary has no digest — re-save it first.");
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error("Not signed in");
      const salt = randomSaltHex();
      const commitment = await ipsCommitment(bundle.digest, salt);
      const { error } = await supabase.from("midnight_anchors").upsert(
        {
          user_id: uid,
          bundle_id: bundle.id,
          digest: bundle.digest,
          commitment,
          network: "undeployed",
          status: "queued",
          entry_point: contractInfo.circuit,
          contract_address:
            contractInfo.address === PLACEHOLDER_ADDRESS ? null : contractInfo.address,
        },
        { onConflict: "user_id,digest,network" },
      );
      if (error) throw error;
      await supabase.from("activity_log").insert({
        user_id: uid,
        kind: "anchor.queued",
        summary: `Queued anchor for "${bundle.title}" (commitment ${commitment.slice(0, 12)}…)`,
        metadata: { digest: bundle.digest } as never,
      });
      return commitment;
    },
    onSuccess: () => {
      toast.success("Anchor queued — submit it with the deploy script, then verify.");
      void qc.invalidateQueries({ queryKey: ["anchors"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deployed = contractInfo.address !== PLACEHOLDER_ADDRESS;

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Midnight · Undeployed"
        title="Midnight network"
        description="A Fly.io-hosted Undeployed stack: node, indexer, and the Docker proof server. Only commitments are written on-chain — never clinical content."
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Fly stack" subtitle="node · indexer · proof server">
          {deployment ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {deployment.app_prefix}-midnight
                </Badge>
                <Badge variant="secondary">{deployment.region}</Badge>
                <Badge
                  className={
                    health.data?.ready ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
                  }
                >
                  {health.isFetching ? "checking…" : health.data?.ready ? "ready" : deployment.status}
                </Badge>
              </div>

              {health.data ? (
                <p className="text-xs text-muted-foreground">
                  Chain height:{" "}
                  <span className="font-mono">
                    {health.data.probes.blockHeight != null
                      ? `#${health.data.probes.blockHeight}`
                      : "no blocks ingested"}
                  </span>
                </p>
              ) : null}

              <ul className="space-y-2 text-sm">
                {[
                  { label: "Indexer GraphQL", value: deployment.indexer_url, probe: health.data?.probes.indexer },
                  { label: "Proof server", value: deployment.proof_url, probe: health.data?.probes.proof },
                  {
                    label: "Node RPC (via indexer sync)",
                    value: deployment.node_url,
                    probe: health.data
                      ? {
                          ok: health.data.probes.blockHeight != null,
                          detail:
                            health.data.probes.blockHeight != null
                              ? `indexer following the chain at #${health.data.probes.blockHeight}`
                              : "indexer is not receiving blocks from this RPC",
                        }
                      : undefined,
                  },
                ].map((row) => (

                  <li key={row.label} className="rounded-md border border-border bg-card/40 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <StatusDot
                        status={row.probe ? (row.probe.ok ? "ok" : "error") : "idle"}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{row.label}</span>
                    </div>
                    <TruncatedMono value={row.value} head={30} tail={12} className="mt-1" />
                    {row.probe ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{row.probe.detail}</p>
                    ) : null}
                  </li>
                ))}
              </ul>

              <ul className="grid gap-2 sm:grid-cols-3">
                {(health.data?.machines ?? (deployment.machines as { name: string; state: string }[] | null) ?? []).map(
                  (m) => (
                    <li key={m.name} className="rounded-md border border-border bg-card/40 px-3 py-2">
                      <p className="truncate text-xs text-muted-foreground">{m.name}</p>
                      <p className="mt-0.5 truncate text-sm">{m.state}</p>
                    </li>
                  ),
                )}
              </ul>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void health.refetch()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Re-check health
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => doDestroy.mutate()}
                  disabled={doDestroy.isPending}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Destroy
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Provision a dedicated Fly app running the Midnight node, the standalone indexer, and the
                proof server. The proof server is published over HTTPS on port 6300 so the browser can reach it.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="prefix">App prefix</Label>
                  <Input
                    id="prefix"
                    value={prefix}
                    placeholder="ips-demo"
                    onChange={(e) => setPrefix(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Region</Label>
                  <Select value={region} onValueChange={setRegion}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FLY_REGIONS.map((r) => (
                        <SelectItem key={r.code} value={r.code}>
                          {r.label} ({r.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button onClick={() => doProvision.mutate()} disabled={doProvision.isPending || prefix.length < 3}>
                {doProvision.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Rocket className="mr-1.5 h-4 w-4" />
                )}
                Provision stack
              </Button>
            </div>
          )}
        </Panel>

        <Panel title="Anchor contract" subtitle={`Compact ${contractInfo.compactVersion} · ${contractInfo.circuit}`}>
          {deployed ? (
            <div className="space-y-3 text-sm">
              <TruncatedMono value={contractInfo.address} label="contract" head={14} tail={8} />
              <TruncatedMono value={contractInfo.deployTx} label="deploy tx" head={14} tail={8} />
              <p className="text-xs text-muted-foreground">
                Anchors call <code className="font-mono">{contractInfo.circuit}</code> with the commitment only.
              </p>
            </div>
          ) : (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                The Compact contract is written and compiled, but not yet deployed. Deployment runs once the
                Fly stack reports ready, using the proof server on port 6300 and the indexer over HTTPS.
              </p>
              <pre className="overflow-x-auto rounded-md bg-secondary/60 p-3 font-mono text-xs">
{`bun scripts/deploy-midnight.mjs \\
  --indexer <indexer-url> \\
  --proof <proof-url>`}
              </pre>
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Anchors" subtitle="Commitments queued and confirmed on the Undeployed ledger">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {bundles?.length ? (
              bundles.map((b) => (
                <Button
                  key={b.id}
                  size="sm"
                  variant="outline"
                  onClick={() => prepareAnchor.mutate(b)}
                  disabled={prepareAnchor.isPending}
                >
                  <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Queue “{b.title}”
                </Button>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Save a summary first to queue an anchor.</p>
            )}
          </div>

          {anchors?.length ? (
            <ul className="space-y-2">
              {anchors.map((a) => (
                <li
                  key={a.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-md border border-border bg-card/40 px-3 py-2"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusDot status={a.status === "confirmed" ? "ok" : a.status === "error" ? "error" : "pending"} />
                      <Badge variant="secondary" className="text-[11px]">
                        {a.status}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">{a.network}</span>
                      {a.block_height ? (
                        <span className="font-mono text-xs text-muted-foreground">block #{a.block_height}</span>
                      ) : null}
                    </div>
                    <TruncatedMono value={a.commitment} label="commitment" />
                    <TruncatedMono value={a.tx_hash} label="tx" />
                    {a.last_error ? <p className="text-xs text-warning">{a.last_error}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button size="sm" variant="outline" onClick={() => doVerify.mutate(a.id)} disabled={doVerify.isPending}>
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Verify
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No anchors yet.</p>
          )}
        </div>
      </Panel>
    </div>
  );
}
