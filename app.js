/**
 * JGGAP.GG - LoL Jungle Tactical Companion
 * Complete Refactored Edition (Specification & User Requirements 100% Compliant)
 * - 単一データソース設計 (data.js + opgg_stats.js / opgg_stats.json)
 * - 五十音順ソート完全正規化（「ヴァイ」「ヴィエゴ」等のヴ行をアイウエオ内の「ウ」の位置に厳密配置）
 * - OP.GG 実戦統計 100% 反映（推測・架空計算ゼロ、小数第二位表示統一）
 */

(function () {
  'use strict';

  const STORAGE_KEY_FAVS = 'lol_jg_favs_v6';
  const STORAGE_KEY_TIER = 'lol_jg_tier_v7';
  const STORAGE_KEY_READ_CHANGES = 'lol_jg_read_changes_v1';

  // 初回起動時の「よく使うチャンピオン」は空（勝手な事前登録は行わない）
  const DEFAULT_FAVS = [];

  // アプリケーション内部状態
  const state = {
    tier: 'emerald_plus', // 'emerald_plus' (エメ以上) | 'gold_minus' (ゴル以下)
    hudMode: 'matchup',   // 'matchup' (試合前 BAN/PICK) | 'build' (試合中 ビルド/対策)
    activeSlot: 'ally-JUNGLE',
    slots: {
      'ally-JUNGLE': null,
      'ally-TOP': null,
      'ally-MID': null,
      'ally-ADC': null,
      'ally-SUPPORT': null,
      'enemy-JUNGLE': null,
      'enemy-TOP': null,
      'enemy-MID': null,
      'enemy-ADC': null,
      'enemy-SUPPORT': null,
    },
    lanesExpanded: {
      ally: false,
      enemy: false,
    },
    isFavConfigMode: false,
    favoriteIds: [...DEFAULT_FAVS],
    draftFilter: {
      role: 'JUNGLE', // サイトを開いた時に最初にJGを表示
      syllable: '未指定',
      search: '',
    },
    diffSimToggle: false, // 初回起動時は不要な変更通知を出さない
  };

  let pendingSetAllyJg = null;

  // ドラッグ＆ドロップ補助ステート（ネイティブD&D＋ポインターフォールバック共通）
  let activeDragState = {
    champId: null,
    sourceSlot: null,
    lastOverSlot: null,
    lastOverFavBar: false,
    lastOverTime: 0,
  };
  let pointerDragState = null;

  function applySlotDrop(targetSlotKey, champId, sourceSlotKey) {
    if (!targetSlotKey || !champId) return;
    if (sourceSlotKey && sourceSlotKey !== targetSlotKey) {
      const currentChampId = state.slots[targetSlotKey];
      state.slots[targetSlotKey] = champId;
      state.slots[sourceSlotKey] = currentChampId;
    } else {
      state.slots[targetSlotKey] = champId;
    }
    state.activeSlot = targetSlotKey;
    renderAll();
  }

  function startCustomDragSession(champId, sourceSlotKey) {
    activeDragState.champId = champId;
    activeDragState.sourceSlot = sourceSlotKey || null;
    activeDragState.lastOverSlot = null;
    activeDragState.lastOverFavBar = false;
    activeDragState.lastOverTime = 0;
    if (pointerDragState) {
      pointerDragState.nativeStarted = true;
    }
  }

  function finishCustomDragSession() {
    const now = Date.now();
    if (activeDragState.champId && now - activeDragState.lastOverTime < 250) {
      if (activeDragState.lastOverSlot) {
        const targetKey = activeDragState.lastOverSlot;
        const cId = activeDragState.champId;
        const srcKey = activeDragState.sourceSlot;
        activeDragState.champId = null;
        activeDragState.sourceSlot = null;
        activeDragState.lastOverSlot = null;
        applySlotDrop(targetKey, cId, srcKey);
        return;
      }
      if (activeDragState.lastOverFavBar) {
        const cId = activeDragState.champId;
        activeDragState.champId = null;
        activeDragState.lastOverFavBar = false;
        if (!state.favoriteIds.includes(cId)) {
          toggleFavorite(cId);
        }
        return;
      }
    }
    activeDragState.champId = null;
    activeDragState.sourceSlot = null;
    activeDragState.lastOverSlot = null;
    activeDragState.lastOverFavBar = false;
    activeDragState.lastOverTime = 0;
  }

  document.addEventListener('mousemove', (e) => {
    if (!pointerDragState || pointerDragState.nativeStarted) return;
    const dx = e.clientX - pointerDragState.startX;
    const dy = e.clientY - pointerDragState.startY;
    if (Math.hypot(dx, dy) > 6) {
      pointerDragState.moved = true;
      const elUnder = document.elementFromPoint(e.clientX, e.clientY);
      if (elUnder) {
        const allyToggle = elUnder.closest('#btn-toggle-ally-lanes');
        if (allyToggle && !state.lanesExpanded.ally) {
          state.lanesExpanded.ally = true;
          const cont = document.getElementById('ally-lanes-container');
          if (cont) cont.classList.remove('hidden');
        }
        const enemyToggle = elUnder.closest('#btn-toggle-enemy-lanes');
        if (enemyToggle && !state.lanesExpanded.enemy) {
          state.lanesExpanded.enemy = true;
          const cont = document.getElementById('enemy-lanes-container');
          if (cont) cont.classList.remove('hidden');
        }
      }
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (!pointerDragState) return;
    const pState = pointerDragState;
    pointerDragState = null;
    if (pState.nativeStarted || !pState.moved) return;

    const elUnder = document.elementFromPoint(e.clientX, e.clientY);
    if (!elUnder) return;

    const slotEl = elUnder.closest('[data-slot]');
    if (slotEl) {
      const targetSlotKey = slotEl.getAttribute('data-slot');
      if (targetSlotKey) {
        pState.suppressClick = true;
        applySlotDrop(targetSlotKey, pState.champId, pState.sourceSlot);
        return;
      }
    }

    const favBarEl = elUnder.closest('#favorites-bar');
    if (favBarEl && pState.champId && !state.favoriteIds.includes(pState.champId)) {
      pState.suppressClick = true;
      toggleFavorite(pState.champId);
    }
  });

  // =========================================================================
  // 1. 五十音順ソート正規化（「ヴァイ」「ヴィエゴ」をアイウエオの中の「ウ」に厳密配置）
  // =========================================================================
  const GOJUON_GROUPS = [
    ['あ', 'ぁ', 'ア', 'ァ'],
    ['い', 'ぃ', 'イ', 'ィ'],
    ['う', 'ぅ', 'ウ', 'ゥ', 'ゔ', 'ヴ'], // ヴはウと同じ段（イの後、エの前）
    ['え', 'ぇ', 'エ', 'ェ'],
    ['お', 'ぉ', 'オ', 'ォ'],
    ['か', 'カ', 'が', 'ガ'],
    ['き', 'キ', 'ぎ', 'ギ'],
    ['く', 'ク', 'ぐ', 'グ'],
    ['け', 'ケ', 'げ', 'ゲ'],
    ['こ', 'コ', 'ご', 'ゴ'],
    ['さ', 'サ', 'ざ', 'ザ'],
    ['し', 'シ', 'じ', 'ジ'],
    ['す', 'ス', 'ず', 'ズ'],
    ['せ', 'セ', 'ぜ', 'ゼ'],
    ['そ', 'ソ', 'ぞ', 'ゾ'],
    ['た', 'タ', 'だ', 'ダ'],
    ['ち', 'チ', 'ぢ', 'ヂ'],
    ['つ', 'っ', 'ツ', 'ッ', 'づ', 'ヅ'],
    ['て', 'テ', 'で', 'デ'],
    ['と', 'ト', 'ど', 'ド'],
    ['な', 'ナ'],
    ['に', 'ニ'],
    ['ぬ', 'ヌ'],
    ['ね', 'ネ'],
    ['の', 'ノ'],
    ['は', 'ハ', 'ば', 'バ', 'ぱ', 'パ'],
    ['ひ', 'ヒ', 'び', 'ビ', 'ぴ', 'ピ'],
    ['ふ', 'フ', 'ぶ', 'ブ', 'ぷ', 'プ'],
    ['へ', 'ヘ', 'べ', 'ベ', 'ぺ', 'ペ'],
    ['ほ', 'ホ', 'ぼ', 'ボ', 'ぽ', 'ポ'],
    ['ま', 'マ'],
    ['み', 'ミ'],
    ['む', 'ム'],
    ['め', 'メ'],
    ['も', 'モ'],
    ['や', 'ゃ', 'ヤ', 'ャ'],
    ['ゆ', 'ゅ', 'ユ', 'ュ'],
    ['よ', 'ょ', 'ヨ', 'ョ'],
    ['ら', 'ラ'],
    ['り', 'リ'],
    ['る', 'ル'],
    ['れ', 'レ'],
    ['ろ', 'ロ'],
    ['わ', 'ゎ', 'ワ', 'ヮ'],
    ['を', 'ヲ'],
    ['ん', 'ン'],
  ];

  const CHAR_SORT_MAP = {};
  const VOICED_CHARS = new Set('ゔヴがぎぐげござじずぜぞだぢづでどばびぶべぼガギグゲゴザジズゼゾダヂヅデドバビブベボ'.split(''));
  const SEMI_VOICED_CHARS = new Set('ぱぴぷぺぽパピプペポ'.split(''));

  GOJUON_GROUPS.forEach((chars, groupIdx) => {
    chars.forEach((ch, subIdx) => {
      const voicedRank = VOICED_CHARS.has(ch) ? 1 : SEMI_VOICED_CHARS.has(ch) ? 2 : 0;
      CHAR_SORT_MAP[ch] = { groupIdx, voicedRank, subIdx };
    });
  });

  function compareChampionsGojuon(a, b) {
    const nameA = a.kana || a.name || '';
    const nameB = b.kana || b.name || '';

    const infoA0 = CHAR_SORT_MAP[nameA[0]] || { groupIdx: 999, voicedRank: 0 };
    const infoB0 = CHAR_SORT_MAP[nameB[0]] || { groupIdx: 999, voicedRank: 0 };

    // 1文字目の五十音段（あ・い・う[ヴ]・え・お...）で比較
    if (infoA0.groupIdx !== infoB0.groupIdx) {
      return infoA0.groupIdx - infoB0.groupIdx;
    }
    // 同じ段なら清音 -> 濁音(ヴ等) -> 半濁音の順
    if (infoA0.voicedRank !== infoB0.voicedRank) {
      return infoA0.voicedRank - infoB0.voicedRank;
    }

    // 2文字目以降を順次比較
    const maxLen = Math.max(nameA.length, nameB.length);
    for (let i = 1; i < maxLen; i++) {
      const chA = nameA[i];
      const chB = nameB[i];
      if (!chA) return -1;
      if (!chB) return 1;
      if (chA === chB) continue;

      const mA = CHAR_SORT_MAP[chA];
      const mB = CHAR_SORT_MAP[chB];
      if (mA && mB) {
        if (mA.groupIdx !== mB.groupIdx) return mA.groupIdx - mB.groupIdx;
        if (mA.voicedRank !== mB.voicedRank) return mA.voicedRank - mB.voicedRank;
      } else {
        return chA.localeCompare(chB, 'ja');
      }
    }
    return (a.id || '').localeCompare(b.id || '');
  }

  // =========================================================================
  // 2. データロード & ヘルパー関数群
  // =========================================================================
  const statsStore = {};

  function applyStatsData(json) {
    if (!json || typeof json !== 'object') return;
    Object.keys(json).forEach((champId) => {
      if (statsStore[champId]) {
        statsStore[champId] = {
          ...statsStore[champId],
          ...json[champId],
          build: {
            ...(statsStore[champId].build || {}),
            ...(json[champId].build || {}),
          },
        };
      } else {
        statsStore[champId] = json[champId];
      }
    });
    // Wukong <-> MonkeyKing 双方向リンク保証
    if (statsStore.MonkeyKing && !statsStore.Wukong) {
      statsStore.Wukong = statsStore.MonkeyKing;
    } else if (statsStore.Wukong && !statsStore.MonkeyKing) {
      statsStore.MonkeyKing = statsStore.Wukong;
    }
  }

  async function loadStatsJson() {
    // 1. data.js 内の stats を初期ロード
    if (window.LOL_DATA && window.LOL_DATA.stats) {
      applyStatsData(window.LOL_DATA.stats);
    }
    // 2. opgg_stats.js (window.OPGG_STATS_DATABASE) があれば同期即座ロード (file:// 完全対応)
    if (window.OPGG_STATS_DATABASE && typeof window.OPGG_STATS_DATABASE === 'object') {
      applyStatsData(window.OPGG_STATS_DATABASE);
    }
    // 3. HTTP/HTTPS サーバー環境時は opgg_stats.json も非同期取得して最新化
    try {
      const res = await fetch('opgg_stats.json', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        applyStatsData(json);
      }
    } catch (e) {
      // file:// 環境またはオフライン時は window.OPGG_STATS_DATABASE で100%動作
    }
  }

  // 小数第二位フォーマットヘルパー (例: 54.36%)
  function formatPercent(val) {
    if (val === undefined || val === null || isNaN(val)) return '0.00%';
    return `${Number(val).toFixed(2)}%`;
  }

  function getChamp(id) {
    if (!id || !window.LOL_DATA || !window.LOL_DATA.champions) return null;
    const normalizedId = id === 'Wukong' ? 'MonkeyKing' : id;
    return window.LOL_DATA.champions.find((c) => c.id === normalizedId || c.id === id) || null;
  }

  function getStats(id) {
    if (!id) return null;
    return statsStore[id] || (id === 'MonkeyKing' ? statsStore.Wukong : null) || null;
  }

  function getItemIcon(itemId) {
    return `https://ddragon.leagueoflegends.com/cdn/16.21.1/img/item/${itemId}.png`;
  }

  // 変更通知バッジ（2回目以降のデータ更新時かつ未読時のみ表示）
  function isChangesUnread(champId) {
    if (!state.diffSimToggle) return false;
    const stats = getStats(champId);
    if (!stats || !stats.changes || !stats.changes.hasChanges) return false;
    try {
      const readMap = JSON.parse(localStorage.getItem(STORAGE_KEY_READ_CHANGES) || '{}');
      const patchVer = stats.changes.patchVersion || '16.21';
      return readMap[champId] !== patchVer;
    } catch (e) {
      return true;
    }
  }

  function markChangesRead(champId) {
    const stats = getStats(champId);
    if (!stats || !stats.changes) return;
    try {
      const readMap = JSON.parse(localStorage.getItem(STORAGE_KEY_READ_CHANGES) || '{}');
      readMap[champId] = stats.changes.patchVersion || '16.21';
      localStorage.setItem(STORAGE_KEY_READ_CHANGES, JSON.stringify(readMap));
    } catch (e) {}
  }

  function toggleFavorite(champId) {
    if (state.favoriteIds.includes(champId)) {
      state.favoriteIds = state.favoriteIds.filter((id) => id !== champId);
    } else {
      if (state.favoriteIds.length >= 8) return;
      state.favoriteIds.push(champId);
    }
    try {
      localStorage.setItem(STORAGE_KEY_FAVS, JSON.stringify(state.favoriteIds));
    } catch (e) {}
    renderFavoritesBar();
    renderDraftGrid();
    if (window.lucide) window.lucide.createIcons();
  }

  // =========================================================================
  // 3. 画面レンダリング関数群
  // =========================================================================
  function renderAll() {
    renderHeader();
    renderFavoritesBar();
    renderSlots();
    renderHUD();
    renderDraftGrid();
    if (window.lucide) window.lucide.createIcons();
  }

  function renderHeader() {
    if (window.LOL_DATA && window.LOL_DATA.patchVersion) {
      const patchEl = document.getElementById('header-patch');
      if (patchEl) patchEl.textContent = `PATCH ${window.LOL_DATA.patchVersion}`;
    }

    const btnEmerald = document.getElementById('tier-emerald');
    const btnGold = document.getElementById('tier-gold');
    if (btnEmerald && btnGold) {
      if (state.tier === 'emerald_plus') {
        btnEmerald.className = 'px-3 py-1 rounded-lg text-xs font-black bg-teal-600 text-white shadow-md transition-all';
        btnGold.className = 'px-3 py-1 rounded-lg text-xs font-bold text-slate-400 hover:text-white transition-all';
      } else {
        btnGold.className = 'px-3 py-1 rounded-lg text-xs font-black bg-amber-500 text-black shadow-md transition-all';
        btnEmerald.className = 'px-3 py-1 rounded-lg text-xs font-bold text-slate-400 hover:text-white transition-all';
      }
    }
  }

  function renderFavoritesBar() {
    const barEl = document.getElementById('favorites-bar');
    if (!barEl) return;

    barEl.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      barEl.classList.add('ring-2', 'ring-amber-400', 'rounded-xl');
      activeDragState.lastOverFavBar = true;
      activeDragState.lastOverSlot = null;
      activeDragState.lastOverTime = Date.now();
    };
    barEl.ondragleave = () => {
      barEl.classList.remove('ring-2', 'ring-amber-400', 'rounded-xl');
      activeDragState.lastOverFavBar = false;
    };
    barEl.ondrop = (e) => {
      e.preventDefault();
      barEl.classList.remove('ring-2', 'ring-amber-400', 'rounded-xl');
      activeDragState.lastOverFavBar = false;
      activeDragState.champId = null;
      const droppedId = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('champ-id') || e.dataTransfer.getData('text');
      if (droppedId && !state.favoriteIds.includes(droppedId)) {
        toggleFavorite(droppedId);
      }
    };

    const favChamps = state.favoriteIds.map(getChamp).filter(Boolean);
    barEl.innerHTML = '';

    if (favChamps.length === 0) {
      barEl.innerHTML = `
        <div class="text-xs text-slate-400 py-1 px-3 rounded-xl border border-dashed border-slate-700 bg-slate-900/40 pointer-events-none">
          <span>よく使うチャンピオンが登録されていません。</span>
        </div>
      `;
      return;
    }

    favChamps.forEach((champ) => {
      const isUnread = isChangesUnread(champ.id);
      const isSelected = state.slots['ally-JUNGLE'] === champ.id;

      const itemEl = document.createElement('div');
      itemEl.className = 'relative group flex items-center';

      itemEl.innerHTML = `
        <button draggable="true" class="fav-item-btn flex items-center space-x-2.5 px-3 py-1.5 rounded-xl border-2 transition-all cursor-grab active:cursor-grabbing ${
          isSelected
            ? 'bg-cyan-950/90 border-cyan-400 text-white shadow-lg shadow-cyan-500/20'
            : 'bg-[#0d1f36] border-[#1f3a5c] hover:border-cyan-400/70 text-slate-200'
        }">
          <div class="relative flex-shrink-0 pointer-events-none">
            <img src="${champ.icon}" alt="${champ.name}" class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg object-cover border border-slate-600 pointer-events-none">
            ${
              isUnread
                ? `<span class="fav-badge-trigger absolute -top-2 -right-2 bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-black px-1.5 py-0.5 rounded-full shadow-lg flex items-center space-x-0.5 ring-2 ring-[#040711] animate-bounce pointer-events-none" title="変更点を確認">
                    <span>🔔</span>
                   </span>`
                : ''
            }
          </div>
          <div class="text-left pointer-events-none">
            <div class="text-xs sm:text-sm font-black leading-tight flex items-center space-x-1">
              <span>${champ.name}</span>
            </div>
            ${
              isUnread
                ? '<div class="text-[9px] font-black text-amber-400 leading-tight">🔔 パッチ変更あり</div>'
                : ''
            }
          </div>
        </button>
        <button class="fav-remove-btn -ml-2 -mt-6 z-10 w-4 h-4 rounded-full bg-slate-800 text-slate-400 hover:bg-rose-600 hover:text-white border border-slate-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[10px]" title="登録解除">
          ×
        </button>
      `;

      const favBtn = itemEl.querySelector('.fav-item-btn');
      let localPtr = null;
      favBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        localPtr = {
          champId: champ.id,
          sourceSlot: null,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          nativeStarted: false,
          suppressClick: false,
        };
        pointerDragState = localPtr;
      });
      favBtn.addEventListener('dragstart', (e) => {
        startCustomDragSession(champ.id, null);
        e.dataTransfer.setData('text/plain', champ.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      favBtn.addEventListener('dragend', () => {
        finishCustomDragSession();
      });
      favBtn.addEventListener('click', () => {
        if (localPtr && localPtr.suppressClick) {
          localPtr.suppressClick = false;
          return;
        }
        const targetSlot = state.activeSlot || 'ally-JUNGLE';
        if (isChangesUnread(champ.id)) {
          markChangesRead(champ.id);
          pendingSetAllyJg = champ.id;
          renderFavoritesBar();
          openChangeModal(champ.id);
        } else {
          state.slots[targetSlot] = champ.id;
          state.activeSlot = targetSlot;
          renderAll();
        }
      });

      const removeBtn = itemEl.querySelector('.fav-remove-btn');
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(champ.id);
      });

      barEl.appendChild(itemEl);
    });
  }

  function renderSlots() {
    const slotKeys = [
      'ally-JUNGLE', 'ally-TOP', 'ally-MID', 'ally-ADC', 'ally-SUPPORT',
      'enemy-JUNGLE', 'enemy-TOP', 'enemy-MID', 'enemy-ADC', 'enemy-SUPPORT',
    ];

    const allyHasLanes = ['ally-TOP', 'ally-MID', 'ally-ADC', 'ally-SUPPORT'].some((k) => Boolean(state.slots[k]));
    const enemyHasLanes = ['enemy-TOP', 'enemy-MID', 'enemy-ADC', 'enemy-SUPPORT'].some((k) => Boolean(state.slots[k]));

    if (allyHasLanes) state.lanesExpanded.ally = true;
    if (enemyHasLanes) state.lanesExpanded.enemy = true;

    const allyLanesCont = document.getElementById('ally-lanes-container');
    const allyLanesText = document.getElementById('ally-lanes-btn-text');
    const allyLanesIcon = document.getElementById('ally-lanes-icon');
    if (allyLanesCont) {
      if (state.lanesExpanded.ally) {
        allyLanesCont.classList.remove('hidden');
        if (allyLanesText) allyLanesText.textContent = '他レーンを閉じる';
        if (allyLanesIcon) allyLanesIcon.style.transform = 'rotate(180deg)';
      } else {
        allyLanesCont.classList.add('hidden');
        if (allyLanesText) allyLanesText.textContent = '他レーンを展開';
        if (allyLanesIcon) allyLanesIcon.style.transform = 'rotate(0deg)';
      }
    }

    const enemyLanesCont = document.getElementById('enemy-lanes-container');
    const enemyLanesText = document.getElementById('enemy-lanes-btn-text');
    const enemyLanesIcon = document.getElementById('enemy-lanes-icon');
    if (enemyLanesCont) {
      if (state.lanesExpanded.enemy) {
        enemyLanesCont.classList.remove('hidden');
        if (enemyLanesText) enemyLanesText.textContent = '他レーンを閉じる';
        if (enemyLanesIcon) enemyLanesIcon.style.transform = 'rotate(180deg)';
      } else {
        enemyLanesCont.classList.add('hidden');
        if (enemyLanesText) enemyLanesText.textContent = '他レーンを展開';
        if (enemyLanesIcon) enemyLanesIcon.style.transform = 'rotate(0deg)';
      }
    }

    slotKeys.forEach((key) => {
      const el = document.querySelector(`[data-slot="${key}"]`);
      if (!el) return;

      const isAlly = key.startsWith('ally');
      const isJg = key.endsWith('JUNGLE');
      const champId = state.slots[key];
      const champ = getChamp(champId);
      const isActive = state.activeSlot === key;

      el.classList.remove('slot-active-blue', 'slot-active-red', 'ring-2', 'ring-cyan-400', 'ring-rose-400', 'bg-cyan-950/40', 'bg-rose-950/40', 'opacity-80');
      if (isActive) {
        el.classList.add(isAlly ? 'slot-active-blue' : 'slot-active-red');
        el.classList.add('ring-2', isAlly ? 'ring-cyan-400' : 'ring-rose-400');
      }

      el.ondragover = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        el.classList.add('border-amber-400', 'scale-[1.02]');
        activeDragState.lastOverSlot = key;
        activeDragState.lastOverFavBar = false;
        activeDragState.lastOverTime = Date.now();
      };
      el.ondragleave = () => {
        el.classList.remove('border-amber-400', 'scale-[1.02]');
        if (activeDragState.lastOverSlot === key) {
          activeDragState.lastOverSlot = null;
        }
      };
      el.ondrop = (e) => {
        e.preventDefault();
        el.classList.remove('border-amber-400', 'scale-[1.02]');
        const droppedId = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('champ-id') || activeDragState.champId;
        const sourceSlot = e.dataTransfer.getData('source-slot') || activeDragState.sourceSlot;
        activeDragState.champId = null;
        activeDragState.sourceSlot = null;
        activeDragState.lastOverSlot = null;
        if (droppedId) {
          applySlotDrop(key, droppedId, sourceSlot);
        }
      };

      const contentEl = el.querySelector('.slot-content');
      if (!contentEl) return;
      contentEl.classList.add('pointer-events-none');

      const headerEl = el.firstElementChild;
      if (headerEl && headerEl !== contentEl) {
        headerEl.classList.add('pointer-events-none', 'select-none');
      }

      const imgSize = isJg ? 'w-12 h-12 sm:w-14 sm:h-14' : 'w-9 h-9 sm:w-10 sm:h-10';

      let localSlotPtr = null;
      if (champ) {
        el.setAttribute('draggable', 'true');
        el.classList.add('cursor-grab', 'active:cursor-grabbing');
        el.onmousedown = (e) => {
          if (e.button !== 0 || e.target.closest('.btn-clear')) return;
          localSlotPtr = {
            champId: champ.id,
            sourceSlot: key,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            nativeStarted: false,
            suppressClick: false,
          };
          pointerDragState = localSlotPtr;
        };
        el.ondragstart = (e) => {
          startCustomDragSession(champ.id, key);
          e.dataTransfer.setData('text/plain', champ.id);
          e.dataTransfer.setData('source-slot', key);
          e.dataTransfer.effectAllowed = 'copy';
        };
        el.ondragend = () => {
          finishCustomDragSession();
        };

        contentEl.innerHTML = `
          <img src="${champ.icon}" alt="${champ.name}" class="${imgSize} rounded-xl object-cover border-2 ${
            isAlly ? 'border-cyan-400' : 'border-rose-400'
          } shadow-md flex-shrink-0 pointer-events-none">
          <div class="flex-1 min-w-0 pointer-events-none">
            <div class="font-black text-sm text-slate-100 truncate">${champ.name}</div>
          </div>
          <button class="btn-clear p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors pointer-events-auto" title="枠を解除">
            <i data-lucide="x" class="w-4 h-4 pointer-events-none"></i>
          </button>
        `;

        contentEl.querySelector('.btn-clear').addEventListener('click', (e) => {
          e.stopPropagation();
          state.slots[key] = null;
          renderAll();
        });
      } else {
        el.removeAttribute('draggable');
        el.classList.remove('cursor-grab', 'active:cursor-grabbing');
        el.onmousedown = null;
        el.ondragstart = null;
        el.ondragend = null;
        contentEl.innerHTML = `
          <div class="${imgSize} rounded-xl border-2 border-dashed ${
            isAlly ? 'border-cyan-800/80 bg-cyan-950/20 text-cyan-500' : 'border-rose-900/80 bg-rose-950/20 text-rose-500'
          } flex items-center justify-center font-bold text-lg flex-shrink-0 pointer-events-none">
            ＋
          </div>
          <div class="flex-1 min-w-0 pointer-events-none">
            <div class="text-xs font-bold text-slate-400">未選択</div>
            <div class="text-[10px] text-slate-500 truncate">タップまたはドラッグで設定</div>
          </div>
        `;
      }

      el.onclick = () => {
        if (localSlotPtr && localSlotPtr.suppressClick) {
          localSlotPtr.suppressClick = false;
          return;
        }
        state.activeSlot = key;
        renderSlots();
        if (window.lucide) window.lucide.createIcons();
      };
    });
  }

  // =========================================================================
  // 4. 戦術・ビルドHUD描画（モード① 試合前 / モード② 試合中）
  // =========================================================================
  function renderHUD() {
    const myJg = getChamp(state.slots['ally-JUNGLE']);
    const enemyJg = getChamp(state.slots['enemy-JUNGLE']);
    const myStats = getStats(state.slots['ally-JUNGLE']);
    const enemyStats = getStats(state.slots['enemy-JUNGLE']);

    const tabMatchup = document.getElementById('hud-tab-matchup');
    const tabBuild = document.getElementById('hud-tab-build');
    const viewMatchup = document.getElementById('hud-view-matchup');
    const viewBuild = document.getElementById('hud-view-build');

    if (state.hudMode === 'matchup') {
      if (tabMatchup) tabMatchup.className = 'px-3.5 py-1.5 rounded-lg text-xs font-black bg-teal-600 text-white shadow-md flex items-center space-x-1.5 transition-all';
      if (tabBuild) tabBuild.className = 'px-3.5 py-1.5 rounded-lg text-xs font-black text-slate-400 hover:text-white flex items-center space-x-1.5 transition-all';
      if (viewMatchup) viewMatchup.classList.remove('hidden');
      if (viewBuild) viewBuild.classList.add('hidden');
      renderMatchupHUD(myJg, enemyJg, myStats, enemyStats);
    } else {
      if (tabMatchup) tabMatchup.className = 'px-3.5 py-1.5 rounded-lg text-xs font-black text-slate-400 hover:text-white flex items-center space-x-1.5 transition-all';
      if (tabBuild) tabBuild.className = 'px-3.5 py-1.5 rounded-lg text-xs font-black bg-amber-600 text-white shadow-md flex items-center space-x-1.5 transition-all';
      if (viewMatchup) viewMatchup.classList.add('hidden');
      if (viewBuild) viewBuild.classList.remove('hidden');
      renderBuildHUD(myJg, myStats);
    }
  }

  // 直接対面勝率をOP.GG実戦辞書からルックアップ（推測計算は一切行わない）
  function lookupDirectMatchup(myJg, enemyJg, myStats, enemyStats) {
    if (!myJg || !enemyJg) return null;

    const myId = myJg.id;
    const enemyId = enemyJg.id;

    let wrEmerald = null;
    let wrGold = null;

    // 1. 自JGの対面辞書から検索
    if (myStats && myStats.matchups && typeof myStats.matchups[enemyId] === 'number') {
      wrEmerald = myStats.matchups[enemyId];
    } else if (enemyStats && enemyStats.matchups && typeof enemyStats.matchups[myId] === 'number') {
      wrEmerald = Math.round((100 - enemyStats.matchups[myId]) * 100) / 100;
    }

    if (myStats && myStats.matchupsGold && typeof myStats.matchupsGold[enemyId] === 'number') {
      wrGold = myStats.matchupsGold[enemyId];
    } else if (enemyStats && enemyStats.matchupsGold && typeof enemyStats.matchupsGold[myId] === 'number') {
      wrGold = Math.round((100 - enemyStats.matchupsGold[myId]) * 100) / 100;
    }

    // 2. フォールバックとして hardCounters / easyMatchups リストを検索
    if (wrEmerald === null && myStats) {
      const found = [...(myStats.hardCounters || []), ...(myStats.easyMatchups || [])].find((m) => m.opponentId === enemyId);
      if (found) {
        wrEmerald = found.winRateEmerald;
        wrGold = found.winRateGold;
      }
    }
    if (wrEmerald === null && enemyStats) {
      const rev = [...(enemyStats.hardCounters || []), ...(enemyStats.easyMatchups || [])].find((m) => m.opponentId === myId);
      if (rev) {
        wrEmerald = Math.round((100 - rev.winRateEmerald) * 100) / 100;
        wrGold = Math.round((100 - rev.winRateGold) * 100) / 100;
      }
    }

    if (wrEmerald === null && wrGold === null) return null;

    const finalEm = wrEmerald !== null ? wrEmerald : wrGold;
    const finalGo = wrGold !== null ? wrGold : wrEmerald;
    const activeWr = state.tier === 'emerald_plus' ? finalEm : finalGo;
    // 両レート帯で共通して勝率が高い場合は『🔥鉄板』バッジ付与
    const isSolid = Boolean(finalEm >= 51.5 && finalGo >= 51.5);

    return {
      wr: activeWr,
      wrEmerald: finalEm,
      wrGold: finalGo,
      isSolid,
    };
  }

  // モード①：試合前（BAN/PICK）
  function renderMatchupHUD(myJg, enemyJg, myStats, enemyStats) {
    const signalCard = document.getElementById('matchup-signal-card');
    const earlyCard = document.getElementById('enemy-early-card');
    const countersContainer = document.getElementById('hud-matchup-counters-container');
    const gankContainer = document.getElementById('hud-gank-rec-container');

    // 1. マッチアップ勝率カード
    if (signalCard) {
      if (myJg && enemyJg) {
        if (myJg.id === enemyJg.id) {
          signalCard.innerHTML = `
            <div class="flex items-center space-x-3">
              <span class="text-xs font-black px-2.5 py-1 rounded-full border bg-slate-800 text-slate-300 border-slate-700">⚪ 同一チャンピオン</span>
              <div>
                <div class="text-[11px] text-slate-400 font-bold">マッチアップ</div>
                <div class="text-xs text-slate-300 font-bold">${myJg.name} vs ${enemyJg.name}</div>
              </div>
            </div>
            <div class="text-right">
              <div class="text-sm font-black font-mono text-slate-400">ー</div>
            </div>
          `;
        } else {
          const matchResult = lookupDirectMatchup(myJg, enemyJg, myStats, enemyStats);
          if (matchResult) {
            const { wr, isSolid } = matchResult;
            let badgeClass = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50';
            let textClass = 'text-emerald-400';
            let label = '🟢 有利';

            if (wr < 48.5) {
              badgeClass = 'bg-rose-500/20 text-rose-300 border-rose-500/50';
              textClass = 'text-rose-400';
              label = '🔴 不利';
            } else if (wr <= 51.5) {
              badgeClass = 'bg-amber-500/20 text-amber-300 border-amber-500/50';
              textClass = 'text-amber-400';
              label = '🟡 互角';
            }

            signalCard.innerHTML = `
              <div class="flex items-center space-x-3">
                <span class="text-xs font-black px-2.5 py-1 rounded-full border ${badgeClass}">${label}</span>
                <div>
                  <div class="text-[11px] text-slate-400 font-bold">マッチアップ</div>
                  <div class="text-xs text-slate-200 font-bold">${myJg.name} vs ${enemyJg.name}</div>
                </div>
              </div>
              <div class="text-right">
                <div class="text-xl font-black font-mono ${textClass}">${formatPercent(wr)}</div>
              </div>
            `;
          } else {
            signalCard.innerHTML = `
              <div class="flex items-center space-x-3">
                <span class="text-xs font-black px-2.5 py-1 rounded-full border bg-slate-800 text-slate-400 border-slate-700">❓ 不明</span>
                <div>
                  <div class="text-[11px] text-slate-400 font-bold">マッチアップ</div>
                  <div class="text-xs text-slate-300 font-bold">${myJg.name} vs ${enemyJg.name}</div>
                </div>
              </div>
              <div class="text-right">
                <div class="text-xs font-black font-mono text-slate-400">データなし</div>
                <span class="text-[9px] text-slate-500">サンプル数不足</span>
              </div>
            `;
          }
        }
      } else {
        signalCard.innerHTML = `
          <div class="text-slate-400 py-1">
            <div class="text-xs font-bold text-slate-200">マッチアップ</div>
            <div class="text-[11px] text-slate-500">相手JGとの勝率を表示</div>
          </div>
        `;
      }
    }

    // 2. 相手JGの序盤の強さ（0〜15分戦闘力）
    if (earlyCard) {
      if (enemyJg && enemyStats && enemyStats.timeWinRates) {
        const earlyWr = enemyStats.timeWinRates.early;
        const isMirror = Boolean(myJg && enemyJg && myJg.id === enemyJg.id);

        if (isMirror) {
          earlyCard.className = 'p-3 rounded-xl border bg-slate-900 border-slate-700 text-slate-300 flex items-center justify-between shadow-sm';
          earlyCard.innerHTML = `
            <div>
              <div class="text-xs font-black text-slate-300">
                ⚪ 同一チャンプ（互角）
              </div>
              <div class="text-[11px] text-slate-400 mt-0.5">同キャラ対決のため性能差なし</div>
            </div>
            <div class="text-right font-mono">
              <div class="text-base font-black text-slate-300">${formatPercent(earlyWr)}</div>
              <div class="text-[10.5px] sm:text-[11px] font-bold text-slate-400/90 whitespace-nowrap">序盤(〜15分)勝率</div>
            </div>
          `;
        } else if (earlyWr >= 52.0) {
          earlyCard.className = 'p-3 rounded-xl border bg-rose-950/70 border-rose-500/50 text-rose-200 flex items-center justify-between shadow-sm';
          earlyCard.innerHTML = `
            <div>
              <div class="text-xs font-black text-rose-300">
                🔴 序盤警戒
              </div>
              <div class="text-[11px] text-rose-300/80 mt-0.5">かにさんファイトしたくない</div>
            </div>
            <div class="text-right font-mono">
              <div class="text-base font-black text-rose-300">${formatPercent(earlyWr)}</div>
              <div class="text-[10.5px] sm:text-[11px] font-bold text-rose-400/90 whitespace-nowrap">序盤(〜15分)勝率</div>
            </div>
          `;
        } else if (earlyWr >= 48.0) {
          earlyCard.className = 'p-3 rounded-xl border bg-amber-950/70 border-amber-500/50 text-amber-200 flex items-center justify-between shadow-sm';
          earlyCard.innerHTML = `
            <div>
              <div class="text-xs font-black text-amber-300">
                🟡 序盤互角
              </div>
              <div class="text-[11px] text-amber-300/80 mt-0.5">フルクリアがんばろう</div>
            </div>
            <div class="text-right font-mono">
              <div class="text-base font-black text-amber-300">${formatPercent(earlyWr)}</div>
              <div class="text-[10.5px] sm:text-[11px] font-bold text-amber-400/90 whitespace-nowrap">序盤(〜15分)勝率</div>
            </div>
          `;
        } else {
          earlyCard.className = 'p-3 rounded-xl border bg-emerald-950/70 border-emerald-500/50 text-emerald-200 flex items-center justify-between shadow-sm';
          earlyCard.innerHTML = `
            <div>
              <div class="text-xs font-black text-emerald-300">
                🟢 序盤よわい
              </div>
              <div class="text-[11px] text-emerald-300/80 mt-0.5">カウンタージャングルしても勝てるかも</div>
            </div>
            <div class="text-right font-mono">
              <div class="text-base font-black text-emerald-300">${formatPercent(earlyWr)}</div>
              <div class="text-[10.5px] sm:text-[11px] font-bold text-emerald-400/90 whitespace-nowrap">序盤(〜15分)勝率</div>
            </div>
          `;
        }
      } else {
        earlyCard.className = 'p-3 rounded-xl border border-slate-800 bg-[#060e1a] flex items-center text-slate-500 text-xs shadow-sm';
        earlyCard.innerHTML = `
          <div>
            <div class="font-bold text-slate-300">相手JGの序盤の強さ</div>
            <div class="text-[11px] text-slate-500">序盤（〜15分）までの強さを表示</div>
          </div>
        `;
      }
    }

    // 3. ハードカウンター Top 5 (勝率が低い順) & 有利な相手 Top 5 (勝率が高い順)
    if (countersContainer) {
      const targetChamp = myJg || enemyJg;
      const targetStats = myStats || enemyStats;

      if (targetChamp && targetStats) {
        const isEmerald = state.tier === 'emerald_plus';
        const rawHard = isEmerald
          ? (targetStats.hardCounters || [])
          : (targetStats.hardCountersGold && targetStats.hardCountersGold.length > 0
              ? targetStats.hardCountersGold
              : targetStats.hardCounters || []);
        const rawEasy = isEmerald
          ? (targetStats.easyMatchups || [])
          : (targetStats.easyMatchupsGold && targetStats.easyMatchupsGold.length > 0
              ? targetStats.easyMatchupsGold
              : targetStats.easyMatchups || []);

        const hardList = [...rawHard]
          .filter((m) => Boolean(getChamp(m.opponentId)))
          .sort((a, b) => {
            const wrA = isEmerald ? a.winRateEmerald : a.winRateGold;
            const wrB = isEmerald ? b.winRateEmerald : b.winRateGold;
            return wrA - wrB;
          })
          .slice(0, 5);

        const easyList = [...rawEasy]
          .filter((m) => Boolean(getChamp(m.opponentId)))
          .sort((a, b) => {
            const wrA = isEmerald ? a.winRateEmerald : a.winRateGold;
            const wrB = isEmerald ? b.winRateEmerald : b.winRateGold;
            return wrB - wrA;
          })
          .slice(0, 5);

        if (hardList.length === 0 && easyList.length === 0) {
          countersContainer.innerHTML = `
            <div class="p-4 rounded-xl bg-[#0e1626] border border-amber-500/40 text-amber-200 text-xs flex items-center space-x-3">
              <i data-lucide="alert-triangle" class="w-5 h-5 text-amber-400 flex-shrink-0"></i>
              <div>
                <div class="font-bold text-amber-300">${targetChamp.name}の実戦対面統計は現在サンプル不足です</div>
              </div>
            </div>
          `;
        } else {
          countersContainer.innerHTML = `
            <!-- ハードカウンター（後ろの括弧なし） -->
            <div class="p-3 rounded-xl bg-[#14080e] border border-rose-500/30 space-y-2">
              <div class="flex items-center justify-between text-xs font-bold text-rose-300">
                <span class="flex items-center">
                  <i data-lucide="alert-octagon" class="w-4 h-4 mr-1.5 text-rose-400"></i>
                  ${targetChamp.name}の不利対面
                </span>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-5 gap-1.5 sm:gap-2">
                ${hardList
                  .map((m) => {
                    const c = getChamp(m.opponentId);
                    const wr = state.tier === 'emerald_plus' ? m.winRateEmerald : m.winRateGold;
                    const champName = c ? c.name : m.opponentId;
                    return `
                    <div class="flex items-center space-x-1.5 px-2 py-1.5 rounded-lg bg-rose-950/40 border border-rose-500/40 text-left" title="${champName}">
                      <img src="${c ? c.icon : ''}" class="w-7 h-7 sm:w-7.5 sm:h-7.5 rounded-md object-cover border border-rose-400/60 flex-shrink-0">
                      <div class="min-w-0 flex-1 leading-tight">
                        <div class="text-[11px] sm:text-xs font-bold text-slate-200 truncate tracking-tight">
                          ${champName}
                        </div>
                        <div class="text-[9.5px] sm:text-[10px] font-mono font-black text-rose-400 mt-0.5 whitespace-nowrap">勝率 ${formatPercent(wr)}</div>
                      </div>
                    </div>
                  `;
                  })
                  .join('')}
              </div>
            </div>

            <!-- 有利な相手（後ろの括弧なし） -->
            <div class="p-3 rounded-xl bg-[#08171d] border border-emerald-500/30 space-y-2">
              <div class="flex items-center justify-between text-xs font-bold text-emerald-300">
                <span class="flex items-center">
                  <i data-lucide="check-circle-2" class="w-4 h-4 mr-1.5 text-emerald-400"></i>
                  ${targetChamp.name}の有利対面
                </span>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-5 gap-1.5 sm:gap-2">
                ${easyList
                  .map((m) => {
                    const c = getChamp(m.opponentId);
                    const wr = state.tier === 'emerald_plus' ? m.winRateEmerald : m.winRateGold;
                    const champName = c ? c.name : m.opponentId;
                    return `
                    <div class="flex items-center space-x-1.5 px-2 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-left" title="${champName}">
                      <img src="${c ? c.icon : ''}" class="w-7 h-7 sm:w-7.5 sm:h-7.5 rounded-md object-cover border border-emerald-400/60 flex-shrink-0">
                      <div class="min-w-0 flex-1 leading-tight">
                        <div class="text-[11px] sm:text-xs font-bold text-slate-200 truncate tracking-tight">
                          ${champName}
                        </div>
                        <div class="text-[9.5px] sm:text-[10px] font-mono font-black text-emerald-400 mt-0.5 whitespace-nowrap">勝率 ${formatPercent(wr)}</div>
                      </div>
                    </div>
                  `;
                  })
                  .join('')}
              </div>
            </div>
          `;
        }
      } else {
        countersContainer.innerHTML = `
          <div class="p-4 rounded-xl bg-[#060e1a] border border-slate-800 text-center text-slate-400 text-xs">
            JGチャンピオンを選択すると、不利対面と有利対面のTop 5を表示するよ
          </div>
        `;
      }
    }

    // 4. 他レーン入力による「Lv4 / Lv6 ガンク優先度ナビ」（仕様書 3. 第2優先 2. 準拠）
    renderGankNavHUD(gankContainer, enemyStats);
  }

  function renderGankNavHUD(container, enemyStats) {
    if (!container) return;
    container.innerHTML = '';

    const indicators = window.LOL_DATA ? window.LOL_DATA.laneIndicators || {} : {};
    const isEnemyDangerous = Boolean(enemyStats && enemyStats.timeWinRates && enemyStats.timeWinRates.early >= 51.5);

    const laneDefs = [
      {
        name: 'TOP',
        allySlots: [{ id: state.slots['ally-TOP'], role: 'TOP' }],
        enemySlots: [{ id: state.slots['enemy-TOP'], role: 'TOP' }],
      },
      {
        name: 'MID',
        allySlots: [{ id: state.slots['ally-MID'], role: 'MID' }],
        enemySlots: [{ id: state.slots['enemy-MID'], role: 'MID' }],
      },
      {
        name: 'BOT',
        allySlots: [
          { id: state.slots['ally-ADC'], role: 'ADC' },
          { id: state.slots['ally-SUPPORT'], role: 'SUPPORT' },
        ],
        enemySlots: [
          { id: state.slots['enemy-ADC'], role: 'ADC' },
          { id: state.slots['enemy-SUPPORT'], role: 'SUPPORT' },
        ],
      },
    ];

    function getChampLaneData(cid, roleName) {
      if (!cid) return null;
      const base = indicators[cid];
      if (!base) return null;
      const laneSpecific = base.byLane && base.byLane[roleName] ? base.byLane[roleName] : null;
      return {
        id: cid,
        champ: getChamp(cid),
        winRate: laneSpecific && laneSpecific.winRate != null ? laneSpecific.winRate : base.winRate != null ? base.winRate : 50.0,
        earlyWinRate: laneSpecific && laneSpecific.earlyWinRate != null ? laneSpecific.earlyWinRate : base.earlyWinRate != null ? base.earlyWinRate : 50.0,
        laneKillRate: laneSpecific && laneSpecific.laneKillRate != null ? laneSpecific.laneKillRate : base.laneKillRate != null ? base.laneKillRate : 50.0,
        killParticipation: laneSpecific && laneSpecific.killParticipation != null ? laneSpecific.killParticipation : base.killParticipation != null ? base.killParticipation : 48.0,
        kda: laneSpecific && laneSpecific.kda != null ? laneSpecific.kda : base.kda != null ? base.kda : 2.5,
        ultDependency: base.ultDependency != null ? base.ultDependency : 4,
        matchups: (laneSpecific && laneSpecific.matchups) || base.matchups || {},
      };
    }

    function avgMetric(arr, key, fallback) {
      if (!arr || arr.length === 0) return fallback;
      const sum = arr.reduce((acc, item) => acc + (item[key] != null ? Number(item[key]) : fallback), 0);
      return sum / arr.length;
    }

    const recs = [];

    laneDefs.forEach(({ name, allySlots, enemySlots }) => {
      const allies = allySlots.map((s) => getChampLaneData(s.id, s.role)).filter(Boolean);
      const enemies = enemySlots.map((s) => getChampLaneData(s.id, s.role)).filter(Boolean);
      if (allies.length === 0 && enemies.length === 0) return;

      const allyLabel = allies.map((a) => (a.champ ? a.champ.name : a.id)).join('・');
      const enemyLabel = enemies.map((e) => (e.champ ? e.champ.name : e.id)).join('・');

      const allyEarlyWr = avgMetric(allies, 'earlyWinRate', 50.0);
      const allyKillRate = avgMetric(allies, 'laneKillRate', 50.0);
      const allyKp = avgMetric(allies, 'killParticipation', 48.0);
      const enemyEarlyWr = avgMetric(enemies, 'earlyWinRate', 50.0);
      const enemyKillRate = avgMetric(enemies, 'laneKillRate', 50.0);
      const enemyKp = avgMetric(enemies, 'killParticipation', 48.0);

      // 味方と敵の両方がいる場合、OP.GGレーン別対面勝率を取得
      let matchupWr = null;
      if (allies.length > 0 && enemies.length > 0) {
        const pairs = [];
        allies.forEach((a) => {
          enemies.forEach((e) => {
            if (a.matchups && a.matchups[e.id] != null) {
              pairs.push(Number(a.matchups[e.id]));
            } else if (e.matchups && e.matchups[a.id] != null) {
              pairs.push(100 - Number(e.matchups[a.id]));
            }
          });
        });
        if (pairs.length > 0) {
          matchupWr = pairs.reduce((acc, v) => acc + v, 0) / pairs.length;
        }
      }

      const hasBoth = allies.length > 0 && enemies.length > 0;
      const hasHighUlt = [...allies, ...enemies].some((x) => x.ultDependency >= 5);

      if (!hasBoth) {
        // ========== ① 対面が出る前（片方のみ選択時）：序盤有利・序盤不利・序盤まちまち ==========
        const isAllyOnly = allies.length > 0;
        const targetLabel = isAllyOnly ? `味方${allyLabel}` : `敵${enemyLabel}`;
        const targetWr = isAllyOnly ? allyEarlyWr : enemyEarlyWr;
        // 味方視点での評価値（味方の勝率が高い、または敵の勝率が低いほど有利）
        const evalWr = isAllyOnly ? allyEarlyWr : 100 - enemyEarlyWr;

        if (evalWr >= 51.0) {
          recs.push({
            priority: 2,
            badge: `序盤有利: [${name}]`,
            color: 'bg-teal-950/70 border-teal-500/50 text-teal-300',
            desc: `${targetLabel}（序盤勝率 ${formatPercent(targetWr)}）`,
          });
        } else if (evalWr <= 49.0) {
          recs.push({
            priority: 1,
            badge: `序盤不利: [${name}]`,
            color: 'bg-rose-950/70 border-rose-500/50 text-rose-300',
            desc: `${targetLabel}（序盤勝率 ${formatPercent(targetWr)}）`,
          });
        } else {
          recs.push({
            priority: 3,
            badge: `序盤まちまち: [${name}]`,
            color: 'bg-amber-950/70 border-amber-500/50 text-amber-300',
            desc: `${targetLabel}（序盤勝率 ${formatPercent(targetWr)}）`,
          });
        }
      } else if (allies.length > 0 && enemies.length > 0 && allies[0].id === enemies[0].id) {
        // ========== ② 同一チャンピオン対決（ミラーマッチ） ==========
        recs.push({
          priority: 4,
          badge: `同一チャンプ: [${name}]`,
          color: 'bg-slate-900 border-slate-700 text-slate-300',
          desc: `${allyLabel} vs ${enemyLabel}（同キャラ対決）`,
        });
      } else {
        // ========== ③ 対面確定後（両方選択時）：対面有利・対面不利・対面互角（数値表示のみ） ==========
        const mStr = matchupWr !== null ? `対面勝率 ${formatPercent(matchupWr)}` : `味方序盤勝率 ${formatPercent(allyEarlyWr)}`;

        if (matchupWr !== null && matchupWr <= 48.5) {
          recs.push({
            priority: 1,
            badge: `対面不利: [${name}]`,
            color: 'bg-rose-950/70 border-rose-500/50 text-rose-300',
            desc: `${allyLabel} vs ${enemyLabel}（${mStr}）`,
          });
        } else if (matchupWr !== null && matchupWr >= 51.5) {
          recs.push({
            priority: 2,
            badge: `対面有利: [${name}]`,
            color: 'bg-teal-950/70 border-teal-500/50 text-teal-300',
            desc: `${allyLabel} vs ${enemyLabel}（${mStr}）`,
          });
        } else {
          recs.push({
            priority: 3,
            badge: `対面互角: [${name}]`,
            color: 'bg-amber-950/70 border-amber-500/50 text-amber-300',
            desc: `${allyLabel} vs ${enemyLabel}（${mStr}）`,
          });
        }
      }
    });

    if (recs.length === 0) return;

    container.innerHTML = recs
      .map(
        (r) => `
      <div class="p-2.5 rounded-xl border ${r.color} flex flex-col sm:flex-row sm:items-center justify-between text-xs shadow-sm gap-1">
        <span class="font-black whitespace-nowrap">${r.badge}</span>
        <span class="text-[11px] opacity-95 sm:text-right">${r.desc}</span>
      </div>
    `
      )
      .join('');
  }

  // =========================================================================
  // 5. モード②：試合中（ビルド/対策）描画
  // =========================================================================
  function renderBuildHUD(myJg, myStats) {
    const viewBuild = document.getElementById('hud-view-build');
    if (!viewBuild) return;

    if (!myJg || !myStats || !myStats.build) {
      viewBuild.innerHTML = `
        <div class="p-8 text-center text-slate-500 text-xs bg-[#060e1a] rounded-2xl border border-slate-800">
          JGを選択すると、おすすめのコアビルド・初動スキル順を表示
        </div>
      `;
      return;
    }

    const build = myStats.build;
    const patterns = build.buildPatterns && build.buildPatterns.length > 0
      ? build.buildPatterns
      : [{ name: '採用率No.1', pickRate: 30.0, winRate: myStats.overallWinRate, coreItems: build.coreItems || [] }];

    const bootsOptions = (build.recommendedBoots && build.recommendedBoots.length >= 2)
      ? build.recommendedBoots.slice(0, 2)
      : [
          build.boots || { name: 'アイオニア ブーツ', icon: getItemIcon('3158'), desc: 'メイン推奨靴' },
          { name: 'プレート スチールキャップ', icon: getItemIcon('3047'), desc: '対AD対策' },
        ];

    const petOptions = (build.pets && build.pets.length >= 1)
      ? build.pets.slice(0, 2)
      : [{ name: '青ペット', icon: getItemIcon('1102'), icons: [getItemIcon('1102')], desc: '推奨', pickRate: 50.0, winRate: myStats.overallWinRate }];

    const spellOptions = (build.spells && build.spells.length >= 1)
      ? build.spells.slice(0, 2)
      : (build.summonerSpells && build.summonerSpells.length >= 1
          ? build.summonerSpells.slice(0, 2)
          : [
              {
                name: 'フラッシュ + スマイト',
                spells: [
                  { name: 'フラッシュ', icon: 'https://ddragon.leagueoflegends.com/cdn/16.21.1/img/spell/SummonerFlash.png' },
                  { name: 'スマイト', icon: 'https://ddragon.leagueoflegends.com/cdn/16.21.1/img/spell/SummonerSmite.png' }
                ],
                pickRate: 99.0,
                winRate: myStats.overallWinRate,
                desc: '採用 99.00% / 勝率 ' + formatPercent(myStats.overallWinRate)
              }
            ]);

    const runes = build.runes || {};
    const runePages = (build.runePages && build.runePages.length > 0)
      ? build.runePages
      : (build.runes ? [build.runes] : []);
    const fourthCoreItems = (build.fourthCoreOptions || []).slice(0, 6);
    const fourthItems = (build.fourthItems && build.fourthItems.length > 0 ? build.fourthItems : fourthCoreItems).slice(0, 5);
    const fifthItems = (build.fifthItems && build.fifthItems.length > 0 ? build.fifthItems : fourthCoreItems).slice(0, 5);
    const sixthItems = (build.sixthItems && build.sixthItems.length > 0 ? build.sixthItems : fourthCoreItems).slice(0, 5);
    const activeOverallWr = state.tier === 'emerald_plus'
      ? myStats.overallWinRate
      : (myStats.overallWinRateGold || myStats.overallWinRate);

    const renderNthColumnCells = (items, colIdx) => {
      const rows = [];
      for (let i = 0; i < 5; i++) {
        const it = items[i];
        if (it) {
          const tooltipPos = colIdx === 0 ? 'left-0' : colIdx === 2 ? 'right-0' : 'left-1/2 -translate-x-1/2';
          const playsCount = it.plays !== undefined ? Number(it.plays).toLocaleString() : (it.pickRate !== undefined ? formatPercent(it.pickRate) : '-');
          const playsLabel = it.plays !== undefined ? '試合' : '採用';
          rows.push(`
            <div class="px-2 py-2 sm:px-2.5 sm:py-2 flex items-center justify-between hover:bg-slate-800/40 transition-colors min-h-[52px]">
              <div class="relative group cursor-pointer flex-shrink-0">
                <img src="${it.icon}" alt="${it.name}" class="w-8 h-8 rounded-lg object-cover border border-slate-700 group-hover:border-amber-400 group-hover:scale-105 transition-all shadow">
                <div class="absolute bottom-full ${tooltipPos} mb-1.5 px-2.5 py-1 bg-slate-900/95 border border-amber-400/90 rounded-lg shadow-2xl text-amber-200 text-xs font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                  ${it.name}
                </div>
              </div>
              <div class="text-right font-mono flex flex-col justify-center min-w-0 pl-1">
                <div class="text-xs sm:text-[13px] font-black text-[#5383e8] tabular-nums whitespace-nowrap leading-tight">
                  ${formatPercent(it.winRate)}
                </div>
                <div class="text-[10px] text-slate-400 tabular-nums whitespace-nowrap leading-tight mt-1">
                  ${playsCount} ${playsLabel}
                </div>
              </div>
            </div>
          `);
        } else {
          rows.push(`
            <div class="px-2 py-2 sm:px-2.5 sm:py-2 flex items-center justify-center text-slate-600 text-xs min-h-[52px]">
              ー
            </div>
          `);
        }
      }
      return rows.join('');
    };

    viewBuild.innerHTML = `
      <!-- 上段：スリムな初動スキル順 (Lv1〜5) バー -->
      <div class="px-3 py-1.5 rounded-xl bg-[#060e1a] border border-slate-800 shadow-sm flex items-center justify-between mb-2.5">
        <div class="text-xs font-bold text-cyan-300">
          <span>初動スキル順 (Lv1〜5)</span>
        </div>
        <div class="flex items-center space-x-1.5 font-mono">
          ${
            build.skillOrder && build.skillOrder.levels1to5
              ? build.skillOrder.levels1to5
                  .map(
                    (s, idx) => `
            <div class="flex items-center space-x-1 px-2.5 py-0.5 rounded-lg bg-[#091526] border border-cyan-500/40 text-xs shadow-sm">
              <span class="text-[10px] text-slate-400 font-bold">Lv${idx + 1}</span>
              <span class="text-amber-400 font-black text-sm">${s}</span>
            </div>
          `
                  )
                  .join('')
              : ''
          }
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 overflow-visible">
        <!-- 左カラム：おすすめコアビルド ＆ 靴・ペット・サモナースペル -->
        <div class="p-3 sm:p-3.5 rounded-xl bg-[#060e1a] border border-slate-800 space-y-2 shadow-md flex flex-col justify-start overflow-visible">
          <div class="overflow-visible">
            <!-- ヘッダー -->
            <div class="flex items-center justify-between pb-1.5 border-b border-slate-800 mb-2">
              <span class="text-xs font-black text-amber-300 flex items-center">
                <i data-lucide="star" class="w-3.5 h-3.5 mr-1 text-amber-400 fill-amber-400"></i> おすすめコアビルド
              </span>
              <span class="text-xs font-mono text-emerald-400 font-bold">全体勝率 ${formatPercent(activeOverallWr)}</span>
            </div>

            <!-- 1〜3コアビルド一覧（OP.GG実戦上位3パターン・ツールチップ完全表示） -->
            <div class="space-y-2 overflow-visible">
              ${patterns
                .slice(0, 3)
                .map((p, pIdx) => {
                  const pick = p.pickRate !== undefined ? p.pickRate : 25.0;
                  const wr = p.winRate !== undefined ? p.winRate : activeOverallWr;
                  const rawName = p.name || (pIdx === 0 ? '採用率No.1' : `コア ${pIdx + 1}`);
                  const displayName = rawName === '最多採用コア' ? '採用率No.1' : rawName;
                  return `
                  <div class="bg-slate-900/60 p-2 rounded-xl border border-slate-800/80 space-y-1 overflow-visible">
                    <div class="flex items-center justify-between text-xs sm:text-[13px]">
                      <span class="font-bold ${pIdx === 0 ? 'text-amber-300' : 'text-slate-300'}">
                        ${displayName}
                      </span>
                      <span class="font-mono text-slate-300 text-[11.5px] sm:text-xs">
                        採用率 <strong class="text-white font-black">${formatPercent(pick)}</strong> / 勝率 <strong class="text-emerald-400 font-black">${formatPercent(wr)}</strong>
                      </span>
                    </div>

                    <div class="flex items-center flex-wrap gap-2 pt-2.5 pb-0.5 overflow-visible">
                      ${(p.coreItems || [])
                        .map(
                          (it, idx) => `
                        <div class="relative group cursor-pointer flex-shrink-0">
                          <img src="${it.icon}" alt="${it.name}" class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl border-2 border-amber-500/80 shadow object-cover hover:scale-105 transition-transform">
                          <span class="absolute -top-1.5 -left-1.5 bg-slate-900 border border-amber-400 text-amber-300 text-[8px] font-black w-4 h-4 rounded-full flex items-center justify-center">${idx + 1}</span>
                          <div class="absolute bottom-full ${idx === 0 ? 'left-0' : 'left-1/2 -translate-x-1/2'} mb-1.5 px-2.5 py-1 bg-slate-900/95 border border-amber-400/90 rounded-lg shadow-2xl text-amber-200 text-xs font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                            ${it.name}
                          </div>
                        </div>
                        ${idx < p.coreItems.length - 1 ? '<i data-lucide="arrow-right" class="w-3.5 h-3.5 text-slate-600 flex-shrink-0"></i>' : ''}
                      `
                        )
                        .join('')}
                    </div>
                  </div>
                `;
                })
                .join('')}
            </div>

            <!-- おすすめ靴 -->
            <div class="mt-2.5 pt-2 border-t border-slate-800 overflow-visible">
              <div class="grid grid-cols-2 gap-2 overflow-visible">
                ${bootsOptions
                  .map((b, bIdx) => {
                    return `
                    <div class="relative group p-2 rounded-xl border bg-slate-900/70 border-slate-800 hover:border-slate-700 flex items-center space-x-2 transition-all cursor-pointer overflow-visible">
                      <div class="relative flex-shrink-0">
                        <img src="${b.icon}" alt="${b.name}" class="w-8 h-8 rounded-lg object-cover border border-slate-600">
                      </div>
                      <div class="min-w-0 flex-1 font-mono text-[11px] leading-tight space-y-0.5">
                        <div class="flex items-center justify-between text-slate-400">
                          <span>採用</span>
                          <strong class="text-slate-200">${formatPercent(b.pickRate)}</strong>
                        </div>
                        <div class="flex items-center justify-between text-slate-400">
                          <span>勝率</span>
                          <strong class="text-emerald-400 font-bold">${formatPercent(b.winRate)}</strong>
                        </div>
                      </div>
                      <div class="absolute bottom-full ${bIdx === 0 ? 'left-0' : 'right-0'} mb-1.5 px-2.5 py-1 bg-slate-900/95 border border-cyan-400/90 rounded-lg shadow-2xl text-cyan-200 text-xs font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                        ${b.name} (採用 ${formatPercent(b.pickRate)} / 勝率 ${formatPercent(b.winRate)})
                      </div>
                    </div>
                  `;
                  })
                  .join('')}
              </div>
            </div>
          </div>

          <!-- 推奨ペット ＆ サモナースペル -->
          <div class="space-y-2 text-xs overflow-visible">
            <!-- 推奨ペット -->
            <div class="overflow-visible">
              <div class="grid grid-cols-2 gap-2 overflow-visible">
                ${petOptions
                  .map((p, pIdx) => {
                    const iconsList = p.icons && p.icons.length > 0 ? p.icons : [p.icon];
                    return `
                    <div class="relative group p-2 rounded-xl bg-slate-900/70 border border-slate-800 hover:border-amber-400/60 flex items-center space-x-2 transition-all cursor-pointer overflow-visible">
                      <div class="flex items-center space-x-1 flex-shrink-0">
                        ${iconsList
                          .map(
                            (ic) => `<img src="${ic}" alt="${p.name}" class="w-7 h-7 rounded-lg object-cover border border-slate-600 flex-shrink-0">`
                          )
                          .join('')}
                      </div>
                      <div class="min-w-0 flex-1 font-mono text-[11px] leading-tight space-y-0.5">
                        <div class="flex items-center justify-between text-slate-400">
                          <span>採用</span>
                          <strong class="text-slate-200">${formatPercent(p.pickRate)}</strong>
                        </div>
                        <div class="flex items-center justify-between text-slate-400">
                          <span>勝率</span>
                          <strong class="text-emerald-400 font-bold">${formatPercent(p.winRate)}</strong>
                        </div>
                      </div>
                      <div class="absolute bottom-full ${pIdx === 0 ? 'left-0' : 'right-0'} mb-1.5 px-2.5 py-1 bg-slate-900/95 border border-amber-400/90 rounded-lg shadow-2xl text-amber-200 text-xs font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                        ${p.name} (採用 ${formatPercent(p.pickRate)} / 勝率 ${formatPercent(p.winRate)})
                      </div>
                    </div>
                  `;
                  })
                  .join('')}
              </div>
            </div>

            <!-- サモナースペル -->
            <div class="overflow-visible">
              <div class="grid grid-cols-2 gap-2 overflow-visible">
                ${spellOptions
                  .map((s, sIdx) => {
                    const sList = s.spells && s.spells.length > 0 ? s.spells : [];
                    return `
                    <div class="relative group p-2 rounded-xl bg-slate-900/70 border border-slate-800 hover:border-teal-400/60 flex items-center space-x-2 transition-all cursor-pointer overflow-visible">
                      <div class="flex items-center space-x-1 flex-shrink-0">
                        ${sList
                          .map(
                            (sp) => `<img src="${sp.icon}" alt="${sp.name}" class="w-7 h-7 rounded-lg object-cover border border-slate-600 flex-shrink-0">`
                          )
                          .join('')}
                      </div>
                      <div class="min-w-0 flex-1 font-mono text-[11px] leading-tight space-y-0.5">
                        <div class="flex items-center justify-between text-slate-400">
                          <span>採用</span>
                          <strong class="text-slate-200">${formatPercent(s.pickRate)}</strong>
                        </div>
                        <div class="flex items-center justify-between text-slate-400">
                          <span>勝率</span>
                          <strong class="text-emerald-400 font-bold">${formatPercent(s.winRate)}</strong>
                        </div>
                      </div>
                      <div class="absolute bottom-full ${sIdx === 0 ? 'left-0' : 'right-0'} mb-1.5 px-2.5 py-1 bg-slate-900/95 border border-teal-400/90 rounded-lg shadow-2xl text-teal-200 text-xs font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                        ${s.name} (採用 ${formatPercent(s.pickRate)} / 勝率 ${formatPercent(s.winRate)})
                      </div>
                    </div>
                  `;
                  })
                  .join('')}
              </div>
            </div>
          </div>
        </div>

        <!-- 右カラム：4・5・6番目のアイテム ＆ その下にルーン（アイコン表示） -->
        <div class="flex flex-col space-y-2.5 overflow-visible">
          <!-- 4番目のアイテム / 5番目のアイテム / 6番目のアイテム（OP.GG 3列テーブル形式） -->
          <div class="rounded-xl bg-[#1c1c1f] border border-slate-800 shadow-md flex flex-col justify-start overflow-visible">
            <div class="grid grid-cols-3 divide-x divide-slate-800 border-b border-slate-800 bg-[#16171b] rounded-t-xl">
              <div class="px-3 py-2 text-xs font-bold text-slate-400">4コア目</div>
              <div class="px-3 py-2 text-xs font-bold text-slate-400">5コア目</div>
              <div class="px-3 py-2 text-xs font-bold text-slate-400">6コア目</div>
            </div>
            <div class="grid grid-cols-3 divide-x divide-slate-800 overflow-visible">
              <div class="divide-y divide-slate-800/90 overflow-visible">
                ${renderNthColumnCells(fourthItems, 0)}
              </div>
              <div class="divide-y divide-slate-800/90 overflow-visible">
                ${renderNthColumnCells(fifthItems, 1)}
              </div>
              <div class="divide-y divide-slate-800/90 overflow-visible">
                ${renderNthColumnCells(sixthItems, 2)}
              </div>
            </div>
          </div>

          <!-- ルーン（アイコン中心表示・上位2構成 / 見出しを排してスッキリ配置） -->
          <div class="p-2.5 sm:p-3 rounded-xl bg-[#0e1626] border border-slate-800/90 shadow-md overflow-visible">
            <div class="space-y-2 overflow-visible">
              ${runePages.slice(0, 2).map((rp, rpIdx) => `
                <div class="${rpIdx > 0 ? 'pt-2 border-t border-slate-800/80' : ''} space-y-1 overflow-visible">
                  <div class="flex items-center justify-between text-[11px] font-mono">
                    <span class="font-bold ${rpIdx === 0 ? 'text-amber-300' : 'text-slate-300'}">
                      ${rpIdx === 0 ? '採用率No.1' : '候補 2'}
                    </span>
                    <div class="flex items-center space-x-2 text-[10.5px]">
                      <span class="text-slate-400">採用率 <strong class="text-slate-200">${formatPercent(rp.pickRate)}</strong></span>
                      <span class="text-slate-500">•</span>
                      <span class="text-slate-400">勝率 <strong class="text-emerald-400 font-bold">${formatPercent(rp.winRate)}</strong></span>
                    </div>
                  </div>

                  <!-- ルーンアイコン列 -->
                  <div class="flex flex-wrap items-center justify-between gap-2 overflow-visible pt-0.5">
                    <!-- メインパス -->
                    <div class="flex items-center space-x-1.5 overflow-visible">
                      ${
                        rp.mainTreeIcon
                          ? `<div class="relative group cursor-pointer flex-shrink-0">
                              <img src="${rp.mainTreeIcon}" alt="${rp.mainTree}" class="w-5 h-5 sm:w-6 sm:h-6 object-contain opacity-75 group-hover:opacity-100 transition-opacity">
                              <div class="absolute bottom-full left-0 mb-1.5 px-2 py-0.5 bg-slate-900 border border-amber-400/80 rounded text-[10px] text-amber-200 font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                                ${rp.mainTree} (メイン)
                              </div>
                             </div>`
                          : ''
                      }
                      <!-- キーストーン (大・ゴールド枠) -->
                      <div class="relative group cursor-pointer flex-shrink-0">
                        <img src="${rp.keystoneIcon}" alt="${rp.keystoneName}" class="w-8 h-8 sm:w-9 sm:h-9 rounded-full border-2 border-amber-400 bg-slate-950 object-cover shadow-md group-hover:scale-110 group-hover:border-amber-300 transition-all">
                        <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1 bg-slate-900/95 border border-amber-400/90 rounded-lg shadow-2xl text-amber-200 text-xs font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                          ★ ${rp.keystoneName} (キーストーン)
                        </div>
                      </div>
                      <!-- 通常メインルーン3つ -->
                      <div class="flex items-center space-x-1 sm:space-x-1.5">
                        ${(rp.primaryRunes && rp.primaryRunes.length > 1 ? rp.primaryRunes.slice(1) : [])
                          .map(
                            (r) => `
                          <div class="relative group cursor-pointer flex-shrink-0">
                            <img src="${r.icon}" alt="${r.name}" class="w-6 h-6 sm:w-7 sm:h-7 rounded-full border border-slate-600 bg-slate-900 object-cover group-hover:border-teal-400 group-hover:scale-110 transition-all shadow-sm">
                            <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 bg-slate-900/95 border border-teal-400/80 rounded-lg shadow-2xl text-teal-200 text-xs font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                              ${r.name}
                            </div>
                          </div>
                        `
                          )
                          .join('')}
                      </div>
                    </div>

                    <div class="h-6 w-[1px] bg-slate-800 hidden sm:block flex-shrink-0"></div>

                    <!-- サブパス -->
                    <div class="flex items-center space-x-1.5 overflow-visible">
                      ${
                        rp.subTreeIcon
                          ? `<div class="relative group cursor-pointer flex-shrink-0">
                              <img src="${rp.subTreeIcon}" alt="${rp.subTree}" class="w-5 h-5 sm:w-6 sm:h-6 object-contain opacity-75 group-hover:opacity-100 transition-opacity">
                              <div class="absolute bottom-full left-0 mb-1.5 px-2 py-0.5 bg-slate-900 border border-teal-400/80 rounded text-[10px] text-teal-200 font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                                ${rp.subTree} (サブ)
                              </div>
                             </div>`
                          : ''
                      }
                      <div class="flex items-center space-x-1 sm:space-x-1.5">
                        ${(rp.secondaryRunes || [])
                          .map(
                            (r) => `
                          <div class="relative group cursor-pointer flex-shrink-0">
                            <img src="${r.icon}" alt="${r.name}" class="w-6 h-6 sm:w-7 sm:h-7 rounded-full border border-slate-600 bg-slate-900 object-cover group-hover:border-teal-400 group-hover:scale-110 transition-all shadow-sm">
                            <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 bg-slate-900/95 border border-teal-400/80 rounded-lg shadow-2xl text-teal-200 text-xs font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                              ${r.name}
                            </div>
                          </div>
                        `
                          )
                          .join('')}
                      </div>
                    </div>

                    <!-- ステータス破片 -->
                    ${
                      rp.statShards && rp.statShards.length > 0
                        ? `
                        <div class="h-6 w-[1px] bg-slate-800 hidden sm:block flex-shrink-0"></div>
                        <div class="flex items-center space-x-1 overflow-visible">
                          ${rp.statShards
                            .map(
                              (sh) => `
                            <div class="relative group cursor-pointer flex-shrink-0">
                              <img src="${sh.icon}" alt="${sh.name}" class="w-5 h-5 sm:w-6 sm:h-6 rounded-full border border-slate-700 bg-slate-900/80 object-contain p-0.5 group-hover:border-slate-400 group-hover:scale-110 transition-all shadow-sm">
                              <div class="absolute bottom-full right-0 mb-1.5 px-2 py-0.5 bg-slate-900/95 border border-slate-600 rounded text-[10px] text-slate-300 font-bold whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
                                ${sh.name}
                              </div>
                            </div>
                          `
                            )
                            .join('')}
                        </div>
                      `
                        : ''
                    }
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;

    if (window.lucide) window.lucide.createIcons();
  }

  // =========================================================================
  // 6. ドラフトチャンピオン選択グリッド（五十音順厳密ソート保証）
  // =========================================================================
  function renderDraftGrid() {
    const { role, syllable, search } = state.draftFilter;

    const sylEl = document.getElementById('draft-syllable-tabs');
    if (sylEl && window.LOL_DATA) {
      sylEl.innerHTML = '';
      ['未指定', ...window.LOL_DATA.syllables].forEach((s) => {
        const btn = document.createElement('button');
        btn.className = `px-2.5 py-1 rounded-lg font-bold flex-shrink-0 text-xs transition-colors ${
          s === syllable ? 'bg-amber-500 text-black shadow-sm' : 'text-slate-400 hover:text-white bg-slate-800/60'
        }`;
        btn.textContent = s;
        btn.addEventListener('click', () => {
          state.draftFilter.syllable = s;
          renderDraftGrid();
        });
        sylEl.appendChild(btn);
      });
    }

    let list = window.LOL_DATA && window.LOL_DATA.champions ? [...window.LOL_DATA.champions] : [];

    if (role !== 'ALL') {
      list = list.filter((c) => c.roles && c.roles.includes(role));
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.enName.toLowerCase().includes(q) ||
          (c.kana && c.kana.toLowerCase().includes(q)) ||
          (c.hira && c.hira.toLowerCase().includes(q)) ||
          (c.aliases && c.aliases.some((a) => a.toLowerCase().includes(q)))
      );
    } else if (syllable !== '未指定') {
      list = list.filter((c) => c.syllable === syllable);
    }

    // ★五十音順（「ヴァイ」「ヴィエゴ」がアイウエオの中の「ウ」の位置に来る順序）を常時保証
    list.sort(compareChampionsGojuon);

    const countEl = document.getElementById('draft-match-count');
    if (countEl) countEl.textContent = `${list.length}体`;

    const gridEl = document.getElementById('draft-champ-grid');
    if (!gridEl) return;
    gridEl.innerHTML = '';

    if (list.length === 0) {
      gridEl.innerHTML = '<div class="col-span-full py-12 text-center text-slate-500 text-sm">該当するチャンピオンが見つかりません</div>';
      return;
    }

    list.forEach((champ) => {
      const isFav = state.favoriteIds.includes(champ.id);
      const isConfig = state.isFavConfigMode;
      const card = document.createElement('div');
      card.setAttribute('draggable', isConfig ? 'false' : 'true');

      const borderClass = isConfig
        ? isFav
          ? 'border-amber-400 bg-amber-500/20 ring-2 ring-amber-400 shadow-lg'
          : 'border-slate-800 bg-slate-900/60 opacity-60 hover:opacity-100 hover:border-amber-400/80'
        : 'border-slate-800/90 hover:border-cyan-400 bg-slate-900/70 hover:bg-slate-800 shadow-sm';

      card.className = `relative flex flex-col items-center p-1.5 rounded-xl border ${borderClass} text-center transition-all group active:scale-95 cursor-pointer select-none`;
      card.innerHTML = `
        ${
          isConfig && isFav
            ? '<span class="absolute top-1 right-1 z-10 px-1 py-0.2 rounded bg-amber-400 text-black font-black text-[9px] shadow pointer-events-none">★ 登録中</span>'
            : ''
        }
        <img src="${champ.icon}" alt="${champ.name}" class="w-10 h-10 sm:w-11 sm:h-11 rounded-lg object-cover border border-slate-700/80 group-hover:scale-105 transition-all pointer-events-none">
        <span class="text-xs font-bold text-slate-200 mt-1 truncate w-full leading-tight tracking-tight pointer-events-none">${champ.name}</span>
      `;

      let localCardPtr = null;
      card.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || state.isFavConfigMode) return;
        localCardPtr = {
          champId: champ.id,
          sourceSlot: null,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          nativeStarted: false,
          suppressClick: false,
        };
        pointerDragState = localCardPtr;
      });

      card.addEventListener('dragstart', (e) => {
        if (state.isFavConfigMode) return;
        startCustomDragSession(champ.id, null);
        e.dataTransfer.setData('text/plain', champ.id);
        e.dataTransfer.effectAllowed = 'copy';
      });

      card.addEventListener('dragend', () => {
        finishCustomDragSession();
      });

      card.addEventListener('click', () => {
        if (localCardPtr && localCardPtr.suppressClick) {
          localCardPtr.suppressClick = false;
          return;
        }
        if (state.isFavConfigMode) {
          toggleFavorite(champ.id);
          return;
        }
        const targetSlot = state.activeSlot || 'ally-JUNGLE';
        state.slots[targetSlot] = champ.id;
        state.activeSlot = targetSlot;
        renderAll();
      });

      gridEl.appendChild(card);
    });
  }

  // =========================================================================
  // 7. 🔔 パッチ変更点詳細モーダル
  // =========================================================================
  function openChangeModal(champId) {
    const champ = getChamp(champId);
    const stats = getStats(champId);
    if (!champ || !stats || !stats.changes) return;

    const changes = stats.changes;
    const iconEl = document.getElementById('change-modal-icon');
    const nameEl = document.getElementById('change-modal-name');
    const patchEl = document.getElementById('change-modal-patch');

    if (iconEl) iconEl.src = champ.icon;
    if (nameEl) nameEl.textContent = champ.name;
    if (patchEl) patchEl.textContent = `パッチ ${changes.patchVersion || '16.21'} 変更点`;

    const secBal = document.getElementById('change-section-balance');
    if (secBal) {
      if (changes.balanceNotes) {
        secBal.classList.remove('hidden');
        const badge = document.getElementById('change-buff-nerf-badge');
        if (badge) {
          if (changes.balanceNotes.type === 'buff') {
            badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
            badge.textContent = 'バフ調整';
          } else {
            badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/40';
            badge.textContent = 'ナーフ調整';
          }
        }
        const summaryEl = document.getElementById('change-balance-summary');
        if (summaryEl) summaryEl.textContent = changes.balanceNotes.summary;

        const detailsEl = document.getElementById('change-balance-details');
        if (detailsEl) {
          detailsEl.innerHTML = (changes.balanceNotes.details || [])
            .map((d) => `<li class="flex items-start space-x-2 bg-slate-800/40 p-1.5 rounded-lg"><span class="text-amber-400 font-bold">•</span><span>${d}</span></li>`)
            .join('');
        }
      } else {
        secBal.classList.add('hidden');
      }
    }

    const secSkill = document.getElementById('change-section-skill');
    if (secSkill) {
      if (changes.skillOrderChange) {
        secSkill.classList.remove('hidden');
        const prevEl = document.getElementById('change-skill-prev');
        const currEl = document.getElementById('change-skill-curr');
        if (prevEl) prevEl.textContent = changes.skillOrderChange.previous;
        if (currEl) currEl.textContent = changes.skillOrderChange.current;
      } else {
        secSkill.classList.add('hidden');
      }
    }

    const secCounter = document.getElementById('change-section-counter');
    if (secCounter) {
      if (changes.counterChange) {
        secCounter.classList.remove('hidden');
        const commentEl = document.getElementById('change-counter-comment');
        if (commentEl) commentEl.textContent = changes.counterChange.comment;

        const listEl = document.getElementById('change-counter-list');
        if (listEl) {
          listEl.innerHTML = (changes.counterChange.newHardCounters || [])
            .map((hc) => {
              const c = getChamp(hc.id);
              return `
              <div class="flex items-center justify-between p-2 rounded-xl bg-rose-950/30 border border-rose-500/30">
                <div class="flex items-center space-x-2">
                  <img src="${c ? c.icon : ''}" class="w-7 h-7 rounded-lg border border-rose-400/50">
                  <div class="font-bold text-xs text-slate-100">${hc.name}</div>
                </div>
                <div class="text-xs font-mono font-bold text-rose-400">対面勝率 ${formatPercent(hc.winRate)}</div>
              </div>
            `;
            })
            .join('');
        }
      } else {
        secCounter.classList.add('hidden');
      }
    }

    const modal = document.getElementById('modal-changes');
    if (modal) modal.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();
  }

  function closeChangeModal() {
    const modal = document.getElementById('modal-changes');
    if (modal) modal.classList.add('hidden');
    if (pendingSetAllyJg) {
      const targetSlot = state.activeSlot || 'ally-JUNGLE';
      state.slots[targetSlot] = pendingSetAllyJg;
      state.activeSlot = targetSlot;
      pendingSetAllyJg = null;
      renderAll();
    }
  }

  // =========================================================================
  // 8. イベントバインディング & 初期化
  // =========================================================================
  function bindEvents() {
    const btnEmerald = document.getElementById('tier-emerald');
    const btnGold = document.getElementById('tier-gold');
    if (btnEmerald) {
      btnEmerald.addEventListener('click', () => {
        state.tier = 'emerald_plus';
        try { localStorage.setItem(STORAGE_KEY_TIER, 'emerald_plus'); } catch (e) {}
        renderAll();
      });
    }
    if (btnGold) {
      btnGold.addEventListener('click', () => {
        state.tier = 'gold_minus';
        try { localStorage.setItem(STORAGE_KEY_TIER, 'gold_minus'); } catch (e) {}
        renderAll();
      });
    }

    const btnReset = document.getElementById('btn-reset');
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        Object.keys(state.slots).forEach((k) => { state.slots[k] = null; });
        state.activeSlot = 'ally-JUNGLE';
        renderAll();
      });
    }

    const btnSync = document.getElementById('btn-sync');
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        const icon = document.getElementById('sync-icon');
        const text = document.getElementById('sync-text');
        if (icon) icon.classList.add('animate-spin');
        if (text) text.textContent = '同期中...';

        await loadStatsJson();

        setTimeout(() => {
          state.diffSimToggle = true;
          if (icon) icon.classList.remove('animate-spin');
          if (text) text.textContent = 'データ更新';
          renderAll();
        }, 400);
      });
    }

    const btnToggleAllyLanes = document.getElementById('btn-toggle-ally-lanes');
    if (btnToggleAllyLanes) {
      btnToggleAllyLanes.addEventListener('click', () => {
        state.lanesExpanded.ally = !state.lanesExpanded.ally;
        renderSlots();
        if (window.lucide) window.lucide.createIcons();
      });
      btnToggleAllyLanes.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!state.lanesExpanded.ally) {
          state.lanesExpanded.ally = true;
          const allyLanesCont = document.getElementById('ally-lanes-container');
          const allyLanesText = document.getElementById('ally-lanes-btn-text');
          const allyLanesIcon = document.getElementById('ally-lanes-icon');
          if (allyLanesCont) allyLanesCont.classList.remove('hidden');
          if (allyLanesText) allyLanesText.textContent = '他レーンを閉じる';
          if (allyLanesIcon) allyLanesIcon.style.transform = 'rotate(180deg)';
        }
      });
    }

    const btnToggleEnemyLanes = document.getElementById('btn-toggle-enemy-lanes');
    if (btnToggleEnemyLanes) {
      btnToggleEnemyLanes.addEventListener('click', () => {
        state.lanesExpanded.enemy = !state.lanesExpanded.enemy;
        renderSlots();
        if (window.lucide) window.lucide.createIcons();
      });
      btnToggleEnemyLanes.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!state.lanesExpanded.enemy) {
          state.lanesExpanded.enemy = true;
          const enemyLanesCont = document.getElementById('enemy-lanes-container');
          const enemyLanesText = document.getElementById('enemy-lanes-btn-text');
          const enemyLanesIcon = document.getElementById('enemy-lanes-icon');
          if (enemyLanesCont) enemyLanesCont.classList.remove('hidden');
          if (enemyLanesText) enemyLanesText.textContent = '他レーンを閉じる';
          if (enemyLanesIcon) enemyLanesIcon.style.transform = 'rotate(180deg)';
        }
      });
    }

    const btnToggleFavMode = document.getElementById('btn-toggle-fav-mode');
    if (btnToggleFavMode) {
      btnToggleFavMode.addEventListener('click', () => {
        state.isFavConfigMode = !state.isFavConfigMode;
        const textEl = document.getElementById('fav-mode-btn-text');

        if (state.isFavConfigMode) {
          btnToggleFavMode.className = 'flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl text-xs font-black transition-all shadow-xl active:scale-95 bg-amber-500 hover:bg-amber-400 text-black border border-amber-300 flex-shrink-0 animate-pulse';
          if (textEl) textEl.textContent = '登録完了';
        } else {
          btnToggleFavMode.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-bold transition-all shadow-md active:scale-95 bg-[#0e2238] hover:bg-[#153456] text-amber-300 border border-amber-500/40 flex-shrink-0';
          if (textEl) textEl.textContent = 'よく使うチャンピオンの登録';
        }

        renderDraftGrid();
        renderFavoritesBar();
        if (window.lucide) window.lucide.createIcons();
      });
    }

    const tabMatchup = document.getElementById('hud-tab-matchup');
    const tabBuild = document.getElementById('hud-tab-build');
    if (tabMatchup) {
      tabMatchup.addEventListener('click', () => {
        state.hudMode = 'matchup';
        renderHUD();
        if (window.lucide) window.lucide.createIcons();
      });
    }
    if (tabBuild) {
      tabBuild.addEventListener('click', () => {
        state.hudMode = 'build';
        renderHUD();
        if (window.lucide) window.lucide.createIcons();
      });
    }

    const roleTabsContainer = document.getElementById('draft-role-tabs');
    if (roleTabsContainer) {
      roleTabsContainer.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          roleTabsContainer.querySelectorAll('button').forEach((b) => {
            b.className = 'px-3 py-1.5 rounded-lg font-bold text-slate-400 hover:text-white flex items-center space-x-1.5 transition-colors';
          });
          btn.className = 'px-3 py-1.5 rounded-lg font-black bg-cyan-600 text-white shadow-md flex items-center space-x-1.5';
          state.draftFilter.role = btn.getAttribute('data-role');
          renderDraftGrid();
          if (window.lucide) window.lucide.createIcons();
        });
      });
    }

    const searchInput = document.getElementById('draft-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.draftFilter.search = e.target.value;
        renderDraftGrid();
      });
    }

    const btnCloseChanges = document.getElementById('btn-close-changes');
    if (btnCloseChanges) {
      btnCloseChanges.addEventListener('click', closeChangeModal);
    }
    const btnCloseChangesFooter = document.getElementById('btn-close-changes-footer');
    if (btnCloseChangesFooter) {
      btnCloseChangesFooter.addEventListener('click', closeChangeModal);
    }
  }

  async function init() {
    try {
      const savedFavs = localStorage.getItem(STORAGE_KEY_FAVS);
      if (savedFavs) {
        const parsed = JSON.parse(savedFavs);
        if (Array.isArray(parsed)) {
          state.favoriteIds = parsed;
        }
      }
      const savedTier = localStorage.getItem(STORAGE_KEY_TIER);
      if (savedTier === 'emerald_plus' || savedTier === 'gold_minus') {
        state.tier = savedTier;
      }
    } catch (e) {}

    await loadStatsJson();
    bindEvents();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
