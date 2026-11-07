import Hls from "hls.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { ExternalPlayer, Playback, Probe, Settings, Source, Subtitle, TorrentStatus } from "../api";
import { copyText, openMenuAt, withMenu, type MenuItem } from "../contextmenu";
import { episodeLabel, getDetail, recallSource, sourceHasLang, trackMatches, videoIdOf, type WatchContext } from "../data";
import { router, type Cleanup, type ViewContext } from "../router";
import { detailRoute, homeRoute, playerRoute, settingsRoute, sourcesRoute } from "../routes";
import { setCrumbs } from "../shell";
import { errMsg, fmtBytes, fmtSpeed, fmtTime, h, icon, kbd, toast, type IconName } from "../ui";
import { bestSource } from "./sources";

const SEEK = 10;
const SAVE_EVERY_MS = 15_000;
const HIDE_CONTROLS_MS = 2600;
const PLAYERS: Record<ExternalPlayer, string> = { mpv: "mpv", vlc: "VLC" };

interface Cue {
  start: number;
  end: number;
  text: string;
}

export function playerView(root: HTMLElement, ctx: ViewContext, watch: WatchContext | null, source: Source | null, resumeAt: number): Cleanup {
  const signal = ctx.signal;
  const home = { label: "Inicio", onClick: () => router.navigate(homeRoute()) };
  const label = watch?.season != null && watch.episode != null ? episodeLabel(watch.season, watch.episode) : null;
  setCrumbs(
    home,
    watch ? { label: watch.title, onClick: () => router.navigate(detailRoute(watch.kind, watch.id, watch.season ?? undefined)) } : "Torrent",
    label ?? "Reproductor",
  );
  if (watch) window.dispatchEvent(new CustomEvent("mw:now-playing", { detail: watch.id }));

  // ---- Estado ----
  let settings: Settings | null = null;
  let playback: Playback | null = null;
  let probe: Probe | null = null;
  let status: TorrentStatus | null = null;
  let mode: "loading" | "direct" | "hls" | "external" | "error" = "loading";
  /** En HLS el video empieza en `offset` segundos del archivo original. */
  let offset = 0;
  let audioTrack = 0;
  let hls: Hls | null = null;
  let cues: Cue[] = [];
  let subDelay = 0;
  let subs: Subtitle[] = [];
  let activeSub: Subtitle | null = null;
  let lastSaved = 0;
  let restarting = false;
  let openedAt = 0;
  let everPlayed = false;
  let slowOffered = false;
  let currentSource: Source | null = null;
  let hideTimer = 0;
  const timers: number[] = [];

  // ---- DOM ----
  const video = h("video", { class: "stage-video", playsInline: true, preload: "auto", autoplay: true });
  const subtitleLayer = h("div", { class: "sub-layer", attrs: { "aria-live": "off" } });
  const overlay = h("div", { class: "stage-overlay" });
  const bufferBadge = h("div", { class: "buffer-badge", hidden: true });
  const titleBar = h(
    "div",
    { class: "stage-top" },
    h("button", { class: "icon-btn", attrs: { "aria-label": "Atrás" }, onclick: () => router.back() }, icon("back")),
    h(
      "div",
      { class: "stage-titles" },
      h("span", { class: "stage-title" }, watch?.title ?? source?.title ?? "Torrent"),
      label ? h("span", { class: "stage-sub" }, `${label}${watch?.episodeName ? ` · ${watch.episodeName}` : ""}`) : null,
    ),
  );

  // Línea de tiempo
  const tlBuffered = h("i", { class: "tl-buffered" });
  const tlDownloaded = h("i", { class: "tl-downloaded" });
  const tlPlayed = h("i", { class: "tl-played" });
  const tlHandle = h("i", { class: "tl-handle" });
  const tlHover = h("span", { class: "tl-hover", hidden: true });
  const timeline = h("div", { class: "timeline", role: "slider", tabIndex: 0, attrs: { "aria-label": "Posición" } }, h("div", { class: "tl-track" }, tlDownloaded, tlBuffered, tlPlayed, tlHandle), tlHover);
  const timeLabel = h("span", { class: "ctl-time" }, "0:00 / 0:00");

  const ctlBtn = (name: IconName, labelText: string, onclick: () => void) =>
    h("button", { class: "ctl-btn", attrs: { "aria-label": labelText }, title: labelText, onclick }, icon(name));
  const playBtn = ctlBtn("play", "Reproducir (Espacio)", () => togglePlay());
  const backBtn10 = ctlBtn("rewind", `Retroceder ${SEEK} s (←)`, () => seekBy(-SEEK));
  const fwdBtn10 = ctlBtn("forward", `Avanzar ${SEEK} s (→)`, () => seekBy(SEEK));
  const muteBtn = ctlBtn("audio", "Silenciar (M)", () => {
    video.muted = !video.muted;
    syncVolume();
  });
  const volume = h("input", { type: "range", class: "ctl-volume", min: "0", max: "1", step: "0.05", value: "1", attrs: { "aria-label": "Volumen" } });
  volume.addEventListener("input", () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    syncVolume();
  });
  const nextBtn = ctlBtn("skip", "Siguiente episodio (N)", () => void goNext());
  nextBtn.hidden = !(watch?.kind === "series");
  const subBtn = ctlBtn("cc", "Subtítulos (C)", () => openSubMenu());
  const audioBtn = ctlBtn("globe", "Idioma de audio", () => openAudioMenu());
  audioBtn.hidden = true;
  const extBtn = ctlBtn("external", "Abrir en mpv o VLC", () => openExternalMenu());
  const fullBtn = ctlBtn("fullscreen", "Pantalla completa (F)", () => toggleFullscreen());

  const controls = h(
    "div",
    { class: "stage-controls" },
    timeline,
    h(
      "div",
      { class: "ctl-row" },
      h("div", { class: "ctl-group" }, playBtn, backBtn10, fwdBtn10, h("div", { class: "ctl-vol" }, muteBtn, volume), timeLabel),
      h("div", { class: "ctl-group" }, nextBtn, audioBtn, subBtn, extBtn, fullBtn),
    ),
  );
  const stage = h("div", { class: "stage stage-cinema" }, video, subtitleLayer, bufferBadge, titleBar, controls, overlay);

  // Barra de estado del torrent bajo el escenario
  const statSpeed = h("span", { class: "stat" });
  const statPeers = h("span", { class: "stat" });
  const statProgress = h("span", { class: "stat" });
  const statMeter = h("span", { class: "meter stat-meter" }, h("i"));
  const statSource = h("button", { class: "stat stat-source", onclick: () => watch && router.navigate(sourcesRoute(watch)) });
  const statMode = h("span", { class: "stat stat-mode" });
  const infoBar = h(
    "div",
    { class: "torrent-bar" },
    h("span", { class: "stat-icon" }, icon("magnet")),
    statSource,
    statMode,
    h("span", { class: "src-spacer" }),
    statSpeed,
    statPeers,
    statProgress,
    statMeter,
  );
  const hints = h(
    "div",
    { class: "player-hint" },
    kbd("Espacio", "Pausa"),
    kbd("←→", "10 s"),
    kbd("F", "Pantalla completa"),
    kbd("C", "Subtítulos"),
    kbd("Z X", "Desfase de subtítulos"),
  );
  root.append(h("div", { class: "page player-page" }, stage, infoBar, hints));

  // ---- Superposición de estado ----
  const showOverlay = (iconName: IconName | "spin", text: string, detail?: string | null, actions: HTMLElement[] = [], liveDetail = false) => {
    overlay.hidden = false;
    overlay.replaceChildren(
      ...[
        (iconName === "spin" ? h("div", { class: "spinner" }) : icon(iconName, "icon overlay-icon")) as Element,
        h("p", { class: "overlay-text" }, text),
        detail ? h("p", { class: liveDetail ? "overlay-detail live" : "overlay-detail" }, detail) : null,
        actions.length ? h("div", { class: "overlay-actions" }, actions) : null,
      ].filter((x): x is Element => !!x),
    );
  };
  const hideOverlay = () => {
    overlay.hidden = true;
    overlay.replaceChildren();
  };
  const fail = (message: string, extra: HTMLElement[] = []) => {
    mode = "error";
    showOverlay("alert", message, null, [
      ...extra,
      ...(watch ? [h("button", { class: "btn btn-sm", onclick: () => router.navigate(sourcesRoute(watch)) }, icon("magnet"), "Otra fuente")] : []),
      h("button", { class: "btn btn-sm btn-ghost", onclick: () => router.back() }, icon("back"), "Volver"),
    ]);
  };

  // ---- Tiempo absoluto (respecto al archivo original) ----
  const now = () => offset + (video.currentTime || 0);
  const total = () => probe?.duration ?? (Number.isFinite(video.duration) ? video.duration : 0);
  /** Hasta dónde se puede saltar sin reiniciar la conversión. */
  const localEnd = () => {
    if (mode !== "hls") return Infinity;
    const s = video.seekable;
    return s.length ? s.end(s.length - 1) : Number.isFinite(video.duration) ? video.duration : 0;
  };

  const seekTo = (t: number) => {
    const dur = total();
    if (dur) t = Math.max(0, Math.min(dur - 1, t));
    else t = Math.max(0, t);
    if (mode === "direct") {
      video.currentTime = t;
    } else if (mode === "hls") {
      const local = t - offset;
      if (local >= 0 && local <= localEnd() - 1) video.currentTime = local;
      else void startHls(t);
    }
    renderTime();
  };
  const seekBy = (d: number) => seekTo(now() + d);

  const togglePlay = () => {
    if (mode !== "direct" && mode !== "hls") return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  const syncVolume = () => {
    muteBtn.replaceChildren(icon(video.muted || video.volume === 0 ? "mute" : "audio"));
    volume.value = video.muted ? "0" : String(video.volume);
    localStorage.setItem("mw:volume", String(video.volume));
  };
  const savedVol = Number(localStorage.getItem("mw:volume") ?? "1");
  if (Number.isFinite(savedVol)) video.volume = Math.max(0, Math.min(1, savedVol));
  syncVolume();

  const renderTime = () => {
    const dur = total();
    const t = now();
    timeLabel.textContent = `${fmtTime(t)} / ${dur ? fmtTime(dur) : "--:--"}`;
    const p = dur ? t / dur : 0;
    tlPlayed.style.width = `${p * 100}%`;
    tlHandle.style.left = `${p * 100}%`;
    if (dur) {
      let end = 0;
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 1) end = Math.max(end, b.end(i));
      tlBuffered.style.left = `${(offset / dur) * 100}%`;
      tlBuffered.style.width = `${Math.max(0, (end + offset - offset) / dur) * 100}%`;
    }
    if (status && status.total) tlDownloaded.style.width = `${(status.downloaded / status.total) * 100}%`;
    playBtn.replaceChildren(icon(video.paused ? "play" : "pause"));
    renderSubtitle(t);
  };

  // Arrastrar en la línea de tiempo
  const posFromEvent = (e: MouseEvent) => {
    const r = timeline.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  timeline.addEventListener("mousemove", (e) => {
    const dur = total();
    if (!dur) return;
    const p = posFromEvent(e);
    tlHover.hidden = false;
    tlHover.textContent = fmtTime(p * dur);
    tlHover.style.left = `${p * 100}%`;
  });
  timeline.addEventListener("mouseleave", () => (tlHover.hidden = true));
  timeline.addEventListener("mousedown", (e) => {
    const dur = total();
    if (!dur) return;
    const move = (ev: MouseEvent) => {
      const p = posFromEvent(ev);
      tlPlayed.style.width = `${p * 100}%`;
      tlHandle.style.left = `${p * 100}%`;
      timeLabel.textContent = `${fmtTime(p * dur)} / ${fmtTime(dur)}`;
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      seekTo(posFromEvent(ev) * dur);
    };
    move(e);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // ---- Subtítulos (renderizado propio: sirve igual en directo y en HLS con desfase) ----
  const renderSubtitle = (t: number) => {
    if (!cues.length) {
      if (subtitleLayer.childElementCount) subtitleLayer.replaceChildren();
      return;
    }
    const at = t - subDelay;
    const active = cues.filter((c) => c.start <= at && at <= c.end);
    const key = active.map((c) => c.start).join(",");
    if (subtitleLayer.dataset.key === key) return;
    subtitleLayer.dataset.key = key;
    subtitleLayer.replaceChildren(...active.map((c) => h("span", { class: "sub-line" }, ...c.text.split("\n").flatMap((l, i) => (i ? [h("br"), l] : [l])))));
  };

  const loadSubtitle = async (s: Subtitle | null) => {
    activeSub = s;
    subBtn.classList.toggle("on", !!s);
    if (!s) {
      cues = [];
      renderSubtitle(now());
      return;
    }
    try {
      const vtt = await api.subtitleVtt(s.url);
      if (signal.aborted || activeSub !== s) return;
      cues = parseVtt(vtt);
      subtitleLayer.dataset.key = "";
      toast(`Subtítulos: ${s.language}${s.release ? ` · ${s.release}` : ""}`, "info");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const openSubMenu = () => {
    const pref = settings?.subtitleLang ?? "spa";
    const byLang = new Map<string, Subtitle[]>();
    for (const s of subs) byLang.set(s.language, [...(byLang.get(s.language) ?? []), s]);
    const langs = [...byLang.keys()].sort((a, b) => {
      const pa = subs.find((s) => s.language === a)?.lang === pref ? 0 : 1;
      const pb = subs.find((s) => s.language === b)?.lang === pref ? 0 : 1;
      return pa - pb || a.localeCompare(b, "es");
    });
    const items: MenuItem[] = [{ label: "Sin subtítulos", checked: !activeSub, run: () => void loadSubtitle(null) }];
    if (!watch) items.push({ title: "Los subtítulos necesitan una película o serie del catálogo" });
    else if (!subs.length) items.push({ title: "No hay subtítulos para este título" });
    for (const lang of langs.slice(0, 12)) {
      items.push("-", { title: `${lang} · ${byLang.get(lang)!.length}` });
      for (const s of byLang.get(lang)!.slice(0, 6)) {
        items.push({ label: s.release ? shorten(s.release, 46) : `${lang} #${s.id}`, checked: activeSub?.id === s.id, hint: s.hearingImpaired ? "SDH" : undefined, run: () => void loadSubtitle(s) });
      }
    }
    if (activeSub) {
      items.push("-", { title: `Desfase: ${subDelay >= 0 ? "+" : ""}${subDelay.toFixed(1)} s` });
      items.push({ label: "Adelantar 0,5 s", hint: "Z", run: () => shiftSubs(-0.5) }, { label: "Retrasar 0,5 s", hint: "X", run: () => shiftSubs(0.5) });
    }
    popMenu(subBtn, items);
  };
  const shiftSubs = (d: number) => {
    subDelay = Math.round((subDelay + d) * 10) / 10;
    subtitleLayer.dataset.key = "";
    toast(`Desfase de subtítulos: ${subDelay >= 0 ? "+" : ""}${subDelay.toFixed(1)} s`, "info");
  };

  const openAudioMenu = () => {
    if (!probe) return;
    popMenu(
      audioBtn,
      probe.audio.map((t) => ({
        label: [langName(t.language), t.title, t.channels ? `${t.channels === 6 ? "5.1" : t.channels === 8 ? "7.1" : `${t.channels} canales`}` : null, t.codec.toUpperCase()].filter(Boolean).join(" · "),
        checked: t.index === audioTrack,
        run: () => {
          if (t.index === audioTrack) return;
          audioTrack = t.index;
          void startHls(now());
        },
      })),
    );
  };

  const openExternalMenu = () => {
    popMenu(
      extBtn,
      (["mpv", "vlc"] as ExternalPlayer[]).map((p) => ({
        label: `Abrir en ${PLAYERS[p]}`,
        icon: "external" as const,
        run: () => void openExternal(p),
      })),
    );
  };

  const openExternal = async (p: ExternalPlayer) => {
    if (!playback) return;
    try {
      video.pause();
      const exe = await api.playExternal(playback.url, displayTitle(), p, activeSub?.url ?? null);
      toast(`Abierto en ${PLAYERS[p]}.`, "ok");
      return exe;
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const displayTitle = () => (watch ? (label ? `${watch.title} · ${label}` : watch.title) : (playback?.name ?? "MovWatch"));

  // ---- Pantalla completa ----
  let fullscreen = false;
  const toggleFullscreen = (force?: boolean) => {
    fullscreen = force ?? !fullscreen;
    document.body.classList.toggle("is-cinema", fullscreen);
    fullBtn.replaceChildren(icon(fullscreen ? "shrink" : "fullscreen"));
    getCurrentWindow()
      .setFullscreen(fullscreen)
      .catch((e: unknown) => console.warn("setFullscreen", e));
  };

  // ---- Ocultar controles ----
  const poke = () => {
    stage.classList.remove("idle");
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!video.paused && (mode === "direct" || mode === "hls")) stage.classList.add("idle");
    }, HIDE_CONTROLS_MS);
  };
  stage.addEventListener("mousemove", poke);
  stage.addEventListener("mouseleave", () => !video.paused && stage.classList.add("idle"));
  video.addEventListener("click", () => togglePlay());
  video.addEventListener("dblclick", () => toggleFullscreen());

  // ---- Eventos del video ----
  video.addEventListener("timeupdate", () => {
    renderTime();
    if (Date.now() - lastSaved > SAVE_EVERY_MS) void saveProgress();
  });
  video.addEventListener("play", () => {
    renderTime();
    poke();
  });
  video.addEventListener("pause", () => {
    renderTime();
    stage.classList.remove("idle");
    void saveProgress();
  });
  video.addEventListener("progress", renderTime);
  video.addEventListener("waiting", () => (bufferBadge.hidden = false));
  video.addEventListener("playing", () => {
    everPlayed = true;
    bufferBadge.hidden = true;
    hideOverlay();
  });
  video.addEventListener("canplay", () => (bufferBadge.hidden = true));
  video.addEventListener("ended", () => {
    void saveProgress(true);
    if (watch?.kind === "series" && settings?.autoNext) void goNext();
  });
  video.addEventListener("error", () => {
    if (restarting || mode === "error") return;
    const err = video.error;
    if (mode === "direct" && err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      fail("La vista integrada no puede reproducir este formato.", needFfmpegActions());
    } else if (mode === "direct") {
      fail(`Error de reproducción: ${err?.message || "desconocido"}`);
    }
  });

  // ---- Progreso ----
  const saveProgress = async (ended = false) => {
    if (!watch || (mode !== "direct" && mode !== "hls")) return;
    const dur = total();
    const pos = ended ? dur : now();
    if (!dur || pos < 5) return;
    lastSaved = Date.now();
    try {
      await api.historyProgress({
        id: watch.id,
        kind: watch.kind,
        title: watch.title,
        poster: watch.poster,
        background: watch.background,
        videoId: videoIdOf(watch),
        season: watch.season,
        episode: watch.episode,
        episodeName: watch.episodeName,
        position: pos,
        duration: dur,
      });
    } catch (e) {
      console.warn("historyProgress", e);
    }
  };

  // ---- Siguiente episodio ----
  const goNext = async () => {
    if (!watch || watch.kind !== "series" || watch.season == null || watch.episode == null) return;
    try {
      const d = await getDetail("series", watch.id);
      const eps = d.videos.filter((v) => v.season > 0);
      const i = eps.findIndex((v) => v.season === watch.season && v.episode === watch.episode);
      const next = eps[i + 1];
      if (!next || (next.released && new Date(next.released).getTime() > Date.now())) {
        toast("No hay más episodios publicados.", "info");
        return;
      }
      router.replace(playerRoute({ ...watch, season: next.season, episode: next.episode, episodeName: next.name }, null));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  // ---- Fuente lenta: ofrecer (y probar) la siguiente mejor ----
  const checkSlow = () => {
    if (!watch || everPlayed || slowOffered || !status || !openedAt || mode === "error" || mode === "external") return;
    const secs = (Date.now() - openedAt) / 1000;
    if (secs < 25 || status.downSpeed > 400 * 1024) return;
    slowOffered = true;
    const actions = overlay.querySelector(".overlay-actions") ?? overlay.appendChild(h("div", { class: "overlay-actions" }));
    overlay.querySelector(".overlay-text")!.textContent = `Esta fuente va muy lenta (${status.peers} ${status.peers === 1 ? "par" : "pares"}).`;
    actions.replaceChildren(
      h("button", { class: "btn btn-sm btn-primary", onclick: () => void tryNextSource() }, icon("bolt"), "Probar otra fuente"),
      h("button", { class: "btn btn-sm", onclick: () => router.navigate(sourcesRoute(watch)) }, icon("magnet"), "Elegir fuente"),
    );
  };

  const tryNextSource = async () => {
    if (!watch || !settings) return;
    const key = `${watch.id}:${watch.season ?? ""}:${watch.episode ?? ""}`;
    const tried = triedSources.get(key) ?? new Set<string>();
    if (currentSource) tried.add(currentSource.infoHash);
    triedSources.set(key, tried);
    showOverlay("spin", "Buscando otra fuente con más pares…");
    try {
      const next = await bestSource(watch, settings.audioLang, tried, settings.onlyAudioLang);
      if (playback) void api.torrentClose(playback.id, true).catch(() => {});
      playback = null;
      router.replace(playerRoute(watch, next, resumeAt));
    } catch (e) {
      fail(errMsg(e));
    }
  };

  // ---- Estadísticas del torrent ----
  const pollStatus = async () => {
    if (!playback || signal.aborted) return;
    try {
      status = await api.torrentStatus(playback.id);
    } catch {
      status = null;
    }
    if (!status || signal.aborted) return;
    const p = status.total ? status.downloaded / status.total : 0;
    statSpeed.replaceChildren(icon("arrowDown"), fmtSpeed(status.downSpeed));
    statPeers.replaceChildren(icon("users"), `${status.peers} pares`);
    statProgress.textContent = status.finished ? "Descargado" : `${Math.floor(p * 100)} % · ${fmtBytes(status.downloaded)} de ${fmtBytes(status.total)}`;
    (statMeter.firstChild as HTMLElement).style.setProperty("--p", String(p));
    bufferBadge.textContent = `Cargando · ${fmtSpeed(status.downSpeed)} · ${status.peers} pares`;
    const detail = overlay.hidden ? null : overlay.querySelector(".overlay-detail.live");
    if (detail) detail.textContent = `${fmtSpeed(status.downSpeed)} · ${status.peers} pares conectados · ${fmtBytes(status.downloaded)}`;
    checkSlow();
    renderTime();
  };

  // ---- Reproducción HLS (ffmpeg) ----
  const startHls = async (from: number) => {
    if (!playback || !probe) return;
    restarting = true;
    mode = "hls";
    const wasPaused = video.paused && video.currentTime > 0;
    bufferBadge.hidden = false;
    hls?.destroy();
    hls = null;
    try {
      const url = await api.mediaRemux({
        id: playback.id,
        file: playback.file,
        start: from,
        audio: audioTrack,
        transcodeVideo: probe.transcodeVideo,
        hevc: probe.videoCodec === "hevc",
      });
      if (signal.aborted) return;
      offset = from;
      if (Hls.isSupported()) {
        hls = new Hls({ startPosition: 0, liveDurationInfinity: false, maxBufferLength: 60, backBufferLength: 120, manifestLoadingTimeOut: 130_000, manifestLoadingMaxRetry: 2, fragLoadingTimeOut: 60_000, fragLoadingMaxRetry: 6 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls?.recoverMediaError();
          } else {
            fail("La conversión del video se interrumpió.", [h("button", { class: "btn btn-sm btn-primary", onclick: () => void startHls(now()) }, icon("replay"), "Reintentar")]);
          }
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        video.src = url;
      }
      video.addEventListener(
        "loadedmetadata",
        () => {
          restarting = false;
          if (video.currentTime > 1) video.currentTime = 0;
          if (!wasPaused) void video.play().catch(() => {});
        },
        { once: true },
      );
    } catch (e) {
      restarting = false;
      fail(errMsg(e), needFfmpegActions());
    }
  };

  const needFfmpegActions = () => [
    h("button", { class: "btn btn-sm btn-primary", onclick: () => void openExternal("mpv") }, icon("external"), "Abrir en mpv"),
    h("button", { class: "btn btn-sm", onclick: () => void openExternal("vlc") }, icon("external"), "Abrir en VLC"),
    h("button", { class: "btn btn-sm btn-ghost", onclick: () => router.navigate(settingsRoute()) }, icon("settings"), "Instalar ffmpeg"),
  ];

  // ---- Arranque ----
  const start = async () => {
    try {
      settings = await api.getSettings();
      if (signal.aborted) return;

      let src = source;
      if (!src && watch) src = recallSource(`${watch.id}:${watch.season ?? ""}:${watch.episode ?? ""}`);
      if (!src) {
        if (!watch) throw new Error("No hay ninguna fuente seleccionada.");
        showOverlay("spin", "Buscando la mejor fuente…", "YTS · The Pirate Bay · EZTV · Knaben · TorrentsCSV");
        src = await bestSource(watch, settings.audioLang, undefined, settings.onlyAudioLang);
        if (signal.aborted) return;
      }
      statSource.replaceChildren(h("span", { class: `src-q q-${(src.quality ?? "sd").toLowerCase()}` }, src.quality === "2160p" ? "4K" : (src.quality ?? "SD")), shorten(src.title, 64));
      statSource.title = `${src.title}\n${src.provider} · ${fmtBytes(src.size)} · ${src.seeders} semillas`;

      // Subtítulos en paralelo.
      if (watch) {
        api.subtitlesList(videoIdOf(watch)).then(
          (list) => {
            if (signal.aborted) return;
            subs = list;
            const pref = settings?.subtitleLang;
            // No hacen falta si el audio ya está en el idioma de los subtítulos.
            const subLangAsAudio = pref === "spl" ? "lat" : pref === "pob" ? "pob" : pref;
            const audioLang = settings!.audioLang;
            const sameLang = !!audioLang && (audioLang === subLangAsAudio || (audioLang === "lat" && subLangAsAudio === "spa"));
            const audioInSubLang = sameLang && sourceHasLang(src!.languages, audioLang);
            if (pref && !audioInSubLang) {
              const match = pickSubtitle(list, pref, src!.title);
              if (match) void loadSubtitle(match);
            }
          },
          (e: unknown) => console.warn("subtitlesList", e),
        );
      }

      currentSource = src;
      const started = Date.now();
      showOverlay("spin", "Conectando con los pares…", "Descargando los metadatos del torrent");
      const tick = window.setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        const d = overlay.querySelector(".overlay-detail");
        if (mode === "loading" && d && !playback) d.textContent = `Descargando los metadatos del torrent · ${s} s`;
        // Sin pares tras 20 s: se ofrece cambiar de fuente sin esperar al límite de 2 minutos.
        if (s >= 20 && watch && !playback && !slowOffered && mode === "loading") {
          slowOffered = true;
          overlay.querySelector(".overlay-text")!.textContent = "Esta fuente no encuentra pares.";
          const actions = overlay.querySelector(".overlay-actions") ?? overlay.appendChild(h("div", { class: "overlay-actions" }));
          actions.replaceChildren(
            h("button", { class: "btn btn-sm btn-primary", onclick: () => void tryNextSource() }, icon("bolt"), "Probar otra fuente"),
            h("button", { class: "btn btn-sm", onclick: () => router.navigate(sourcesRoute(watch)) }, icon("magnet"), "Elegir fuente"),
          );
        }
      }, 1000);
      timers.push(tick);
      const opened = await api.torrentOpen(src.magnet, displayTitle(), watch?.season, watch?.episode);
      window.clearInterval(tick);
      // Si ya se salió (o se cambió de fuente) mientras conectaba, no dejarlo descargando.
      if (signal.aborted) {
        void api.torrentClose(opened.id, true).catch(() => {});
        return;
      }
      playback = opened;
      slowOffered = false;
      openedAt = Date.now();
      if (signal.aborted) return;
      timers.push(window.setInterval(() => void pollStatus(), 1000));
      void pollStatus();

      // Reproductor externo elegido en Ajustes.
      if (settings.player !== "builtin") {
        mode = "external";
        const p = settings.player;
        await openExternal(p);
        showOverlay("external", `Reproduciendo en ${PLAYERS[p]}`, "El torrent sigue descargándose mientras lo ves. Cierra esta vista para detenerlo.", [
          h("button", { class: "btn btn-sm", onclick: () => void openExternal(p) }, icon("replay"), "Abrir de nuevo"),
          h("button", { class: "btn btn-sm btn-ghost", onclick: () => void copyText(playback!.url) }, icon("link"), "Copiar URL"),
        ]);
        return;
      }

      const tools = await api.detectTools().catch(() => ({ ffmpeg: null, ffprobe: null }));
      const fileName = playback.files[playback.file]?.name ?? "";
      const webPlayable = /\.(mp4|m4v|webm|mov)$/i.test(fileName);
      if (tools.ffprobe) {
        showOverlay("spin", "Preparando el video…", "Leyendo el principio del archivo", [], true);
        try {
          probe = await api.mediaProbe(playback.id, playback.file);
        } catch (e) {
          console.warn("mediaProbe", e);
          probe = null;
        }
        if (signal.aborted) return;
      }
      // Sin análisis (sin ffprobe o la fuente va muy lenta): se decide por la extensión.
      if (!probe && tools.ffmpeg && !webPlayable) {
        probe = { duration: null, container: "", videoCodec: null, pixFmt: null, width: null, height: null, audio: [], subtitles: [], direct: false, transcodeVideo: false };
      }
      if (probe && probe.audio.length > 1) {
        audioBtn.hidden = false;
        const lang = settings.audioLang;
        const pref = lang ? probe.audio.find((t) => trackMatches(lang, t.language, t.title)) : null;
        audioTrack = (pref ?? probe.audio.find((t) => t.default) ?? probe.audio[0]).index;
        if (lang && pref && pref !== probe.audio[0]) toast(`Audio: ${langName(pref.language)}${pref.title ? ` · ${pref.title}` : ""}`, "info");
        else if (lang && !pref) toast("Esta fuente no tiene audio en el idioma elegido; se usa la pista original.", "info");
      }

      if (!probe && !webPlayable) {
        statMode.textContent = "Necesita ffmpeg";
        fail(`La vista integrada no reproduce archivos ${fileName.split(".").pop()?.toUpperCase() ?? ""} sin ffmpeg.`, needFfmpegActions());
        return;
      }
      if (!probe || probe.direct) {
        mode = "direct";
        statMode.textContent = "Directo";
        showOverlay("spin", "Cargando…", "Esperando datos del torrent…", [], true);
        video.src = playback.url;
        if (resumeAt > 5) video.addEventListener("loadedmetadata", () => (video.currentTime = resumeAt), { once: true });
        void video.play().catch(() => {});
      } else {
        statMode.textContent = probe.transcodeVideo ? "Convirtiendo (ffmpeg)" : "Reempaquetado (ffmpeg)";
        mode = "loading";
        showOverlay("spin", "Cargando…", "Esperando datos del torrent…", [], true);
        await startHls(resumeAt > 5 ? resumeAt : 0);
      }
    } catch (e) {
      if (!signal.aborted) fail(errMsg(e));
    }
  };
  void start();

  // ---- Teclado ----
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const handled = (() => {
      switch (k) {
        case " ":
        case "k":
          togglePlay();
          return true;
        case "arrowleft":
          seekBy(-SEEK);
          return true;
        case "arrowright":
          seekBy(SEEK);
          return true;
        case "arrowup":
          video.volume = Math.min(1, video.volume + 0.1);
          syncVolume();
          return true;
        case "arrowdown":
          video.volume = Math.max(0, video.volume - 0.1);
          syncVolume();
          return true;
        case "m":
          video.muted = !video.muted;
          syncVolume();
          return true;
        case "f":
          toggleFullscreen();
          return true;
        case "escape":
          if (fullscreen) {
            toggleFullscreen(false);
            return true;
          }
          return false;
        case "c":
          openSubMenu();
          return true;
        case "z":
          if (activeSub) shiftSubs(-0.5);
          return true;
        case "x":
          if (activeSub) shiftSubs(0.5);
          return true;
        case "n":
          void goNext();
          return true;
        default:
          return false;
      }
    })();
    if (handled) {
      e.preventDefault();
      poke();
    }
  };
  window.addEventListener("keydown", onKey);

  withMenu(stage, () => [
    { label: video.paused ? "Reproducir" : "Pausar", icon: video.paused ? "play" : "pause", hint: "Espacio", run: togglePlay },
    { label: "Subtítulos…", icon: "cc", hint: "C", run: openSubMenu },
    { label: fullscreen ? "Salir de pantalla completa" : "Pantalla completa", icon: "fullscreen", hint: "F", run: () => toggleFullscreen() },
    "-",
    { label: "Abrir en mpv", icon: "external", disabled: !playback, run: () => void openExternal("mpv") },
    { label: "Abrir en VLC", icon: "external", disabled: !playback, run: () => void openExternal("vlc") },
    { label: "Copiar URL local del video", icon: "link", disabled: !playback, run: () => void (playback && copyText(playback.url)) },
    {
      label: "Mostrar carpeta de descarga",
      icon: "folder",
      disabled: !playback,
      run: async () => {
        if (!playback) return;
        try {
          await openPath(await api.torrentReveal(playback.id, playback.file));
        } catch (e) {
          toast(errMsg(e), "error");
        }
      },
    },
    ...(watch ? (["-", { label: "Elegir otra fuente…", icon: "magnet", run: () => router.navigate(sourcesRoute(watch)) }] as MenuItem[]) : []),
  ]);

  // ---- Limpieza ----
  return () => {
    void saveProgress();
    window.removeEventListener("keydown", onKey);
    timers.forEach((t) => window.clearInterval(t));
    window.clearTimeout(hideTimer);
    if (fullscreen) toggleFullscreen(false);
    hls?.destroy();
    video.removeAttribute("src");
    video.load();
    void api.mediaStop();
    // Se pausa (no se borra): reabrirlo continúa donde estaba. Descargas permite cerrarlo.
    if (playback && mode !== "external") void api.torrentPause(playback.id, true).catch(() => {});
    window.dispatchEvent(new CustomEvent("mw:now-playing", { detail: null }));
  };
}

// ---------------------------------------------------------------------------

const popMenu = openMenuAt;

/** Fuentes ya probadas (lentas) por película/episodio durante la sesión. */
const triedSources = new Map<string, Set<string>>();

function shorten(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const LANGS: Record<string, string> = {
  spa: "Español", es: "Español", esp: "Español", eng: "Inglés", en: "Inglés", fre: "Francés", fra: "Francés", ger: "Alemán", deu: "Alemán",
  ita: "Italiano", por: "Portugués", jpn: "Japonés", kor: "Coreano", rus: "Ruso", chi: "Chino", zho: "Chino", cat: "Catalán", lat: "Latino",
  fr: "Francés", it: "Italiano", de: "Alemán", pt: "Portugués", ja: "Japonés", ko: "Coreano", ru: "Ruso", hin: "Hindi", pob: "Portugués (Brasil)",
};
function langName(code: string | null): string {
  if (!code) return "Pista";
  return LANGS[code.toLowerCase()] ?? code.toUpperCase();
}

/** El subtítulo del idioma preferido cuyo nombre de lanzamiento más se parece al torrent. */
function pickSubtitle(list: Subtitle[], lang: string, torrentTitle: string): Subtitle | null {
  const same = list.filter((s) => s.lang === lang || (lang === "spa" && (s.lang === "spn" || s.lang === "spl")));
  if (!same.length) return null;
  const words = new Set(torrentTitle.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const score = (s: Subtitle) => (s.release ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length - (s.hearingImpaired ? 0.5 : 0);
  return [...same].sort((a, b) => score(b) - score(a))[0];
}

function parseVtt(text: string): Cue[] {
  const out: Cue[] = [];
  const time = (s: string) => {
    const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return NaN;
    return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
  };
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = time(a);
    const end = time(b.split(/\s+/).filter(Boolean)[0] ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const body = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (body) out.push({ start, end, text: body });
  }
  return out.sort((x, y) => x.start - y.start);
}
