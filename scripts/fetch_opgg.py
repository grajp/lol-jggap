#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JGGAP.GG - OP.GG 公式API & ビルドページ 実戦統計・チャンピオンマスター完全同期スクリプト (v4)
外部ライブラリ依存ゼロ (Python標準ライブラリ urllib, gzip, re, json, concurrent.futures のみ使用)
- OP.GG Direct Champion API から エメ以上(emerald_plus) & ゴル以下(gold) の両レート帯データを小数第二位精度で取得
- OP.GG ビルドページから 4番目のアイテム / 5番目のアイテム / 6番目のアイテム (各上位5選・勝率・試合数) を完全取得
- 初期アイテム(ペット)上位2選、おすすめ靴上位2足、コアビルド上位3パターン、ハードカウンター/有利な相手5選(レート帯別厳密ソート)を完全同期
- data.js の五十音順（「ヴァイ」「ヴィエゴ」等のヴ行＝アイウエオの中の「ウ」の位置）を厳密にソート
"""

import urllib.request
import gzip
import re
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

DDRAGON_VER = "16.21.1"
OPGG_API_BASE = "https://lol-api-champion.op.gg/api/global/champions/ranked"
OPGG_WEB_BASE = "https://www.op.gg/ja/lol/champions"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
}
HTML_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja-JP,ja;q=0.9",
    "Accept-Encoding": "gzip",
}

def fetch_url_text(url, headers=HEADERS, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as res:
                raw = res.read()
                if res.info().get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw.decode("utf-8", errors="ignore")
        except Exception as e:
            if attempt == retries - 1:
                raise e
            time.sleep(0.5 * (attempt + 1))
    return ""

def fetch_json(url, retries=3):
    text = fetch_url_text(url, headers=HEADERS, retries=retries)
    return json.loads(text) if text else None

# ============================================================================
# 五十音順ソートキー生成（「ヴ」を「ウ」の直後＝アイウエオの中に厳密配置）
# ============================================================================
GOJUON_GROUPS = [
    ("あ", "ぁ", "ア", "ァ"),
    ("い", "ぃ", "イ", "ィ"),
    ("う", "ぅ", "ウ", "ゥ", "ゔ", "ヴ"),  # ヴはウと同じ「う」段グループ（ウの直後、エの前）
    ("え", "ぇ", "エ", "ェ"),
    ("お", "ぉ", "オ", "ォ"),
    ("か", "カ", "が", "ガ"),
    ("き", "キ", "ぎ", "ギ"),
    ("く", "ク", "ぐ", "グ"),
    ("け", "ケ", "げ", "ゲ"),
    ("こ", "コ", "ご", "ゴ"),
    ("さ", "サ", "ざ", "ザ"),
    ("し", "シ", "じ", "ジ"),
    ("す", "ス", "ず", "ズ"),
    ("せ", "セ", "ぜ", "ゼ"),
    ("そ", "ソ", "ぞ", "ゾ"),
    ("た", "タ", "だ", "ダ"),
    ("ち", "チ", "ぢ", "ヂ"),
    ("つ", "っ", "ツ", "ッ", "づ", "ヅ"),
    ("て", "テ", "で", "デ"),
    ("と", "ト", "ど", "ド"),
    ("な", "ナ"),
    ("に", "ニ"),
    ("ぬ", "ヌ"),
    ("ね", "ネ"),
    ("の", "ノ"),
    ("は", "ハ", "ば", "バ", "ぱ", "パ"),
    ("ひ", "ヒ", "び", "ビ", "ぴ", "ピ"),
    ("ふ", "フ", "ぶ", "ブ", "ぷ", "プ"),
    ("へ", "ヘ", "べ", "ベ", "ぺ", "ペ"),
    ("ほ", "ホ", "ぼ", "ボ", "ぽ", "ポ"),
    ("ま", "マ"),
    ("み", "ミ"),
    ("む", "ム"),
    ("め", "メ"),
    ("も", "モ"),
    ("や", "ゃ", "ヤ", "ャ"),
    ("ゆ", "ゅ", "ユ", "ュ"),
    ("よ", "ょ", "ヨ", "ョ"),
    ("ら", "ラ"),
    ("り", "リ"),
    ("る", "ル"),
    ("れ", "レ"),
    ("ろ", "ロ"),
    ("わ", "ゎ", "ワ", "ヮ"),
    ("を", "ヲ"),
    ("ん", "ン"),
]

CHAR_SORT_MAP = {}
for group_idx, chars in enumerate(GOJUON_GROUPS):
    for sub_idx, ch in enumerate(chars):
        is_voiced = 1 if ch in ("ゔ", "ヴ") or ch in "がぎぐげござじずぜぞだぢづでどばびぶべぼガギグゲゴザジズゼゾダヂヅデドバビブベボ" else (2 if ch in "ぱぴぷぺぽパピプペポ" else 0)
        CHAR_SORT_MAP[ch] = (group_idx, is_voiced, sub_idx)

def get_syllable_tab(name_str):
    """チャンピオン名から五十音タブ（あ, か, さ, た, な, は, ま, や, ら, わ）を返す"""
    if not name_str:
        return "あ"
    ch = name_str[0]
    if ch in CHAR_SORT_MAP:
        g_idx = CHAR_SORT_MAP[ch][0]
        if g_idx <= 4: return "あ"
        if g_idx <= 9: return "か"
        if g_idx <= 14: return "さ"
        if g_idx <= 19: return "た"
        if g_idx <= 24: return "な"
        if g_idx <= 29: return "は"
        if g_idx <= 34: return "ま"
        if g_idx <= 37: return "や"
        if g_idx <= 42: return "ら"
        return "わ"
    return "あ"

def get_gojuon_sort_key(champ):
    name = champ.get("kana") or champ.get("name") or ""
    primary_list = []
    voiced_list = []
    for ch in name:
        if ch in ("・", "＝", " ", "　", "ー"):
            primary_list.append(99 if ch == "ー" else 98)
            voiced_list.append(0)
        elif ch in CHAR_SORT_MAP:
            g_idx, is_voiced, _ = CHAR_SORT_MAP[ch]
            primary_list.append(g_idx)
            voiced_list.append(is_voiced)
        else:
            primary_list.append(100 + ord(ch))
            voiced_list.append(0)
    first_group = primary_list[0] if primary_list else 999
    first_voiced = voiced_list[0] if voiced_list else 0
    return (first_group, first_voiced, primary_list, voiced_list, champ.get("id", ""))

def main():
    sys.stdout.reconfigure(encoding="utf-8")
    print("=" * 68)
    print("LoL JGGAP")
    print("=" * 68)

    out_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    data_js_path = os.path.join(out_dir, "data.js")
    json_path = os.path.join(out_dir, "opgg_stats.json")
    js_path = os.path.join(out_dir, "opgg_stats.js")

    # 1. 既存の data.js を読み込む
    with open(data_js_path, "r", encoding="utf-8") as f:
        raw_data_js = f.read()
    json_part = raw_data_js.split("window.LOL_DATA = ")[1].split(";\n")[0]
    lol_data = json.loads(json_part)

    # 2. Data Dragon (ja_JP) からチャンピオン・アイテム・ルーン辞書を取得
    print("[1/4] Data Dragon (ja_JP) から公式マスターデータを取得中...")
    dd_champs = fetch_json(f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VER}/data/ja_JP/champion.json")["data"]
    dd_items = fetch_json(f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VER}/data/ja_JP/item.json")["data"]
    dd_runes = fetch_json(f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VER}/data/ja_JP/runesReforged.json")
    dd_spells = fetch_json(f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VER}/data/ja_JP/summoner.json")["data"]

    spell_map = {}
    for sid, sinfo in dd_spells.items():
        key = int(sinfo["key"])
        spell_map[key] = {
            "id": sid,
            "name": sinfo["name"],
            "icon": f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VER}/img/spell/{sinfo['image']['full']}"
        }

    stat_mod_names = {
        5008: "アダプティブフォース",
        5005: "攻撃速度",
        5007: "スキルヘイスト",
        5002: "物理防御",
        5003: "魔法防御",
        5001: "体力 (レベル比例)",
        5011: "体力",
        5010: "移動速度",
        5013: "行動妨害耐性"
    }

    num_id_to_champ_id = {}
    champ_id_to_num_id = {}
    for cid, cinfo in dd_champs.items():
        num_id = int(cinfo["key"])
        num_id_to_champ_id[num_id] = cid
        champ_id_to_num_id[cid] = num_id

    # アイテム辞書構築
    item_name_map = {
        1101: "赤ペット",
        1102: "青ペット",
        1103: "緑ペット",
        2003: "ポーション",
    }
    completed_items_set = set()
    for iid_str, iinfo in dd_items.items():
        iid = int(iid_str)
        if iid not in item_name_map:
            item_name_map[iid] = iinfo["name"]
        into = iinfo.get("into", [])
        total_gold = iinfo.get("gold", {}).get("total", 0)
        if (not into and total_gold >= 1600) or iid == 3041:
            completed_items_set.add(iid)

    # ルーン辞書構築
    rune_tree_map = {}
    rune_perk_map = {}
    for tree in dd_runes:
        tid = int(tree["id"])
        rune_tree_map[tid] = {
            "name": tree["name"],
            "icon": f"https://ddragon.leagueoflegends.com/cdn/img/{tree['icon']}"
        }
        for slot in tree.get("slots", []):
            for r in slot.get("runes", []):
                rid = int(r["id"])
                rune_perk_map[rid] = {
                    "name": r["name"],
                    "icon": f"https://ddragon.leagueoflegends.com/cdn/img/{r['icon']}"
                }

    def get_item_icon(iid):
        return f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VER}/img/item/{iid}.png"

    def get_item_name(iid):
        return item_name_map.get(int(iid), dd_items.get(str(iid), {}).get("name", f"アイテム({iid})"))

    # 3. OP.GG Ranked List API から全173体のポジション情報・JG対象リストを取得
    print("[2/4] OP.GG Ranked API から全チャンピオンのロール・統計一覧を取得中...")
    ranked_emerald = fetch_json(f"{OPGG_API_BASE}?tier=emerald_plus")["data"]

    opgg_pos_map = {}
    opgg_jg_num_ids = set()
    pos_name_convert = {
        "TOP": "TOP",
        "JUNGLE": "JUNGLE",
        "MID": "MID",
        "ADC": "ADC",
        "SUPPORT": "SUPPORT",
    }

    for entry in ranked_emerald:
        num_id = entry["id"]
        positions = entry.get("positions", [])
        pos_list = []
        for p in positions:
            pname = pos_name_convert.get(p["name"])
            if pname:
                pos_list.append(pname)
            if pname == "JUNGLE":
                opgg_jg_num_ids.add(num_id)
        opgg_pos_map[num_id] = {
            "roles": pos_list,
            "positions_raw": positions,
            "avg_stats": entry.get("average_stats", {})
        }

    target_jg_champ_ids = set()
    for c in lol_data["champions"]:
        cid = c["id"]
        num_id = champ_id_to_num_id.get(cid)
        if num_id and num_id in opgg_pos_map:
            opgg_roles = opgg_pos_map[num_id]["roles"]
            merged_roles = list(opgg_roles) if opgg_roles else list(c.get("roles", []))
            if num_id in opgg_jg_num_ids and "JUNGLE" not in merged_roles:
                merged_roles.insert(0, "JUNGLE")
            elif "JUNGLE" in c.get("roles", []) and "JUNGLE" not in merged_roles:
                merged_roles.append("JUNGLE")
            c["roles"] = merged_roles

        if cid in ("Olaf", "Brand", "Poppy", "Morgana", "Zaahen", "Locke") and "JUNGLE" not in c.get("roles", []):
            c["roles"].append("JUNGLE")

        if "JUNGLE" in c.get("roles", []):
            target_jg_champ_ids.add(cid)

        c["syllable"] = get_syllable_tab(c.get("kana") or c.get("name"))

        if num_id and num_id in opgg_pos_map:
            p_raw = opgg_pos_map[num_id]["positions_raw"]
            main_p = p_raw[0]["stats"] if p_raw else opgg_pos_map[num_id]["avg_stats"]
            wr = round(main_p.get("win_rate", 0.50) * 100, 2)
            kda = round(main_p.get("kda", 2.5), 2)
            prev_ind = lol_data.get("laneIndicators", {}).get(cid, {})
            ult_dep = prev_ind.get("ultDependency", 4)
            if cid in ("Malphite", "Amumu", "Nocturne", "Fiddlesticks", "Karthus", "Diana", "Evelynn", "Vi", "Sejuani", "Zac", "Skarner", "Lissandra", "Galio", "Shen", "Ashe", "Varus", "Leona", "Nautilus", "Rell"):
                ult_dep = 5
            lol_data.setdefault("laneIndicators", {})[cid] = {
                "winRate": wr,
                "earlyWinRate": prev_ind.get("earlyWinRate", wr),
                "midWinRate": prev_ind.get("midWinRate", wr),
                "lateWinRate": prev_ind.get("lateWinRate", wr),
                "laneKillRate": prev_ind.get("laneKillRate", round(min(65.0, max(38.0, 50.0 + (kda - 2.5) * 4.5)), 2)),
                "killParticipation": prev_ind.get("killParticipation", 48.0),
                "kda": kda,
                "ultDependency": ult_dep,
                "matchups": prev_ind.get("matchups", {}),
                "byLane": prev_ind.get("byLane", {}),
            }

    # 五十音順（「ヴァイ」「ヴィエゴ」がアイウエオの中のウの直後に来る順序）で厳密ソート
    lol_data["champions"].sort(key=get_gojuon_sort_key)

    # 3.5 全173体のレーン別実戦統計（序盤勝率・レーンキル率・キル関与率・KDA・レーン別対面勝率）をOP.GGから取得
    print(f"[2.5/4] 全チャンピオン ({len(lol_data['champions'])}体) のOP.GGレーン別実戦統計を取得中...")

    def fetch_single_lane_pos(num_id, slug, pos_name, fallback_stats):
        pos_lower = pos_name.lower()
        wr = round((fallback_stats.get("win_rate") or 0.50) * 100, 2)
        kda = round(fallback_stats.get("kda") or 2.5, 2)
        pick_r = round((fallback_stats.get("pick_rate") or 0.01) * 100, 2)
        ban_r = round((fallback_stats.get("ban_rate") or 0.01) * 100, 2)
        tier_val = (fallback_stats.get("tier_data") or {}).get("tier") or 3

        early_wr = wr
        mid_wr = wr
        late_wr = wr
        matchups_map = {}

        try:
            api_res = fetch_json(f"{OPGG_API_BASE}/{num_id}/{pos_lower}?tier=emerald_plus", retries=2)
            api_data = api_res.get("data", {}) if api_res else {}
            if api_data:
                gl_map = {}
                for g in api_data.get("game_lengths", []):
                    if g.get("rate") is not None:
                        gl_map[g.get("game_length")] = round(g["rate"] * 100, 2)
                early_wr = gl_map.get(0, wr)
                mid_wr = gl_map.get(25, wr)
                late_wr = gl_map.get(35, gl_map.get(40, wr))

                for cnt in api_data.get("counters", []):
                    opp_id = num_id_to_champ_id.get(cnt.get("champion_id"))
                    play = cnt.get("play", 0)
                    win = cnt.get("win", 0)
                    if opp_id and play > 0:
                        opp_wr = round((win / play) * 100, 2)
                        matchups_map[opp_id] = opp_wr
                        if opp_id == "MonkeyKing":
                            matchups_map["Wukong"] = opp_wr
        except Exception:
            pass

        lane_kill_rate = round(min(62.0, max(40.0, 50.0 + (kda - 2.5) * 4.0)), 2)
        kill_part = 48.0
        try:
            c_url = f"{OPGG_WEB_BASE}/{slug}/counters/{pos_lower}?tier=emerald_plus"
            c_html = fetch_url_text(c_url, headers=HTML_HEADERS, retries=2)
            if c_html:
                m_lkr = re.search(r">([\d.]+)%</span><span[^>]*>レーンキル率", c_html)
                m_kp = re.search(r">([\d.]+)%</span><span[^>]*>キル関与率", c_html)
                if m_lkr:
                    lane_kill_rate = round(float(m_lkr.group(1)), 2)
                if m_kp:
                    kill_part = round(float(m_kp.group(1)), 2)
        except Exception:
            pass

        return {
            "lane": pos_name,
            "winRate": wr,
            "earlyWinRate": early_wr,
            "midWinRate": mid_wr,
            "lateWinRate": late_wr,
            "laneKillRate": lane_kill_rate,
            "killParticipation": kill_part,
            "kda": kda,
            "pickRate": pick_r,
            "banRate": ban_r,
            "tier": tier_val,
            "matchups": matchups_map,
        }

    def fetch_champ_lane_indicators(champ_obj):
        cid = champ_obj["id"]
        lookup_id = "MonkeyKing" if cid == "Wukong" else cid
        num_id = champ_id_to_num_id.get(lookup_id)
        if not num_id or num_id not in opgg_pos_map:
            return cid, None

        slug = lookup_id.lower()
        p_raw = opgg_pos_map[num_id]["positions_raw"]
        avg_st = opgg_pos_map[num_id]["avg_stats"]

        # 非JGポジションがあれば優先し、なければ全ポジションの先頭を使用
        non_jg_positions = [p for p in p_raw if pos_name_convert.get(p.get("name")) in ("TOP", "MID", "ADC", "SUPPORT")]
        target_positions = non_jg_positions if non_jg_positions else (p_raw[:1] if p_raw else [{"name": "MID", "stats": avg_st}])

        by_lane = {}
        primary_data = None
        for idx, p_entry in enumerate(target_positions):
            pname = pos_name_convert.get(p_entry.get("name"), "MID")
            pstats = p_entry.get("stats") or avg_st
            lane_res = fetch_single_lane_pos(num_id, slug, pname, pstats)
            by_lane[pname] = lane_res
            if idx == 0:
                primary_data = lane_res

        prev_ind = lol_data.get("laneIndicators", {}).get(cid, {})
        ult_dep = prev_ind.get("ultDependency", 4)
        if cid in ("Malphite", "Amumu", "Nocturne", "Fiddlesticks", "Karthus", "Diana", "Evelynn", "Vi", "Sejuani", "Zac", "Skarner", "Lissandra", "Galio", "Shen", "Ashe", "Varus", "Leona", "Nautilus", "Rell"):
            ult_dep = 5

        return cid, {
            "primaryLane": primary_data["lane"],
            "winRate": primary_data["winRate"],
            "earlyWinRate": primary_data["earlyWinRate"],
            "midWinRate": primary_data["midWinRate"],
            "lateWinRate": primary_data["lateWinRate"],
            "laneKillRate": primary_data["laneKillRate"],
            "killParticipation": primary_data["killParticipation"],
            "kda": primary_data["kda"],
            "pickRate": primary_data["pickRate"],
            "banRate": primary_data["banRate"],
            "tier": primary_data["tier"],
            "ultDependency": ult_dep,
            "matchups": primary_data["matchups"],
            "byLane": by_lane,
        }

    with ThreadPoolExecutor(max_workers=12) as lane_executor:
        lane_futures = {lane_executor.submit(fetch_champ_lane_indicators, c): c["id"] for c in lol_data["champions"]}
        lane_done = 0
        for future in as_completed(lane_futures):
            lane_done += 1
            cid = lane_futures[future]
            try:
                _, l_ind = future.result()
                if l_ind:
                    lol_data.setdefault("laneIndicators", {})[cid] = l_ind
                    if cid == "MonkeyKing":
                        lol_data["laneIndicators"]["Wukong"] = l_ind
                    if lane_done % 25 == 0 or lane_done == len(lol_data["champions"]):
                        print(f"  [レーン統計 {lane_done:3d}/{len(lol_data['champions'])}] {cid:14s} (序盤勝率:{l_ind['earlyWinRate']:.2f}%, レーンキル率:{l_ind['laneKillRate']:.2f}%, キル関与率:{l_ind['killParticipation']:.2f}%)")
            except Exception as e:
                print(f"  [レーン統計エラー] {cid}: {e}")

    if "--lanes-only" in sys.argv:
        print("[完了] --lanes-only 指定のため data.js の laneIndicators を更新して終了します...")
        with open(data_js_path, "w", encoding="utf-8") as f:
            f.write("/**\n * LoL Jungle Tactical Companion - Master Data\n * 五十音順・OP.GG公式ロール・実戦統計完全同期版\n */\n")
            f.write("window.LOL_DATA = ")
            json.dump(lol_data, f, ensure_ascii=False, indent=2)
            f.write(";\n")
        print(f"  - data.js 更新完了 ({os.path.getsize(data_js_path):,} bytes)")
        return

    # 4. 全JG対象チャンピオンの 詳細ビルド & 4/5/6番目アイテム & 全対面勝率 を並列取得
    jg_list_sorted = [c["id"] for c in lol_data["champions"] if c["id"] in target_jg_champ_ids]
    print(f"[3/4] 全JGチャンピオン ({len(jg_list_sorted)}体) のAPI・4/5/6コア・カウンターデータを取得中...")

    def parse_nth_items_from_html(cid):
        """OP.GG ビルドページHTMLから 4番目のアイテム / 5番目のアイテム / 6番目のアイテム (各上位5選) を抽出"""
        slug = cid.lower()
        url = f"{OPGG_WEB_BASE}/{slug}/build/jungle?tier=emerald_plus"
        out = {"fourthItems": [], "fifthItems": [], "sixthItems": []}
        try:
            html = fetch_url_text(url, headers=HTML_HEADERS, retries=2)
            if not html:
                return out
            for key, label in [
                ("fourthItems", "4コア目"),
                ("fifthItems", "5コア目"),
                ("sixthItems", "6コア目"),
            ]:
                idx = html.find(label)
                if idx == -1:
                    continue
                end_idx = html.find("</tbody>", idx)
                tbody = html[idx:end_idx] if end_idx != -1 else html[idx:idx + 4000]
                matches = re.findall(
                    r"item/(\d+)\.png.*?<strong[^>]*>([\d.]+)%</strong><span[^>]*>([\d,]+)\s*試合</span>",
                    tbody,
                    re.S,
                )
                for iid_str, wr_str, plays_str in matches[:5]:
                    iid = int(iid_str)
                    out[key].append({
                        "id": iid,
                        "name": get_item_name(iid),
                        "icon": get_item_icon(iid),
                        "winRate": round(float(wr_str), 2),
                        "plays": int(plays_str.replace(",", "")),
                    })
        except Exception:
            pass
        return out

    def fetch_single_jg_champ(cid):
        num_id = champ_id_to_num_id.get(cid)
        if not num_id:
            return cid, None

        em_res = fetch_json(f"{OPGG_API_BASE}/{num_id}/jungle?tier=emerald_plus")
        go_res = fetch_json(f"{OPGG_API_BASE}/{num_id}/jungle?tier=gold")
        nth_items_data = parse_nth_items_from_html(cid)

        em_data = em_res.get("data", {}) if em_res else {}
        go_data = go_res.get("data", {}) if go_res else {}

        if not em_data:
            return cid, None

        # (A) 基本統計 (JGポジション単体の正確な勝率・ピック率・バン率)
        def extract_pos_stats(d_obj):
            summary = d_obj.get("summary", {})
            for pos in summary.get("positions", []):
                if pos.get("name") == "JUNGLE" and pos.get("stats"):
                    st = pos["stats"]
                    return (
                        round((st.get("win_rate") or 0.50) * 100, 2),
                        round((st.get("pick_rate") or 0.01) * 100, 2),
                        round((st.get("ban_rate") or 0.01) * 100, 2),
                    )
            avg = summary.get("average_stats", {})
            return (
                round((avg.get("win_rate") or 0.50) * 100, 2),
                round((avg.get("pick_rate") or 0.01) * 100, 2),
                round((avg.get("ban_rate") or 0.01) * 100, 2),
            )

        overall_wr, pick_rate, ban_rate = extract_pos_stats(em_data)
        overall_wr_gold, pick_rate_gold, ban_rate_gold = extract_pos_stats(go_data) if go_data else (overall_wr, pick_rate, ban_rate)

        # (B) 時間帯別勝率
        gl_map = {}
        for g in em_data.get("game_lengths", []):
            gl_map[g.get("game_length")] = round((g.get("rate") or 0.50) * 100, 2)
        time_win_rates = {
            "early": gl_map.get(0, overall_wr),
            "mid1": gl_map.get(25, overall_wr),
            "mid2": gl_map.get(30, overall_wr),
            "late": gl_map.get(35, gl_map.get(40, overall_wr)),
        }

        # (C) 全対面マッチアップ勝率辞書 (エメ以上 & ゴル以下)
        matchups_em = {}
        em_counter_entries = []
        for cnt in em_data.get("counters", []):
            opp_id = num_id_to_champ_id.get(cnt.get("champion_id"))
            play = cnt.get("play", 0)
            win = cnt.get("win", 0)
            if opp_id and opp_id != cid and play > 0:
                wr = round((win / play) * 100, 2)
                matchups_em[opp_id] = wr
                em_counter_entries.append({
                    "opponentId": opp_id,
                    "winRate": wr,
                    "plays": play,
                })

        matchups_go = {}
        go_counter_entries = []
        if go_data:
            for cnt in go_data.get("counters", []):
                opp_id = num_id_to_champ_id.get(cnt.get("champion_id"))
                play = cnt.get("play", 0)
                win = cnt.get("win", 0)
                if opp_id and opp_id != cid and play > 0:
                    wr = round((win / play) * 100, 2)
                    matchups_go[opp_id] = wr
                    go_counter_entries.append({
                        "opponentId": opp_id,
                        "winRate": wr,
                        "plays": play,
                    })

        # (D) OP.GG 準拠：ハードカウンター 5選 (勝率が低い順) & 有利な相手 5選 (勝率が高い順)
        # エメ以上 (emerald_plus)
        sorted_em_hard = sorted(em_counter_entries, key=lambda x: (x["winRate"], -x["plays"]))
        hard_counters = []
        for item in sorted_em_hard[:5]:
            opp_id = item["opponentId"]
            wr_em = item["winRate"]
            wr_go = matchups_go.get(opp_id, wr_em)
            hard_counters.append({
                "opponentId": opp_id,
                "winRateEmerald": wr_em,
                "winRateGold": wr_go,
                "plays": item["plays"],
                "isSolidPick": bool(wr_em <= 48.0 and wr_go <= 48.5),
            })

        sorted_em_easy = sorted(em_counter_entries, key=lambda x: (-x["winRate"], -x["plays"]))
        easy_matchups = []
        for item in sorted_em_easy[:5]:
            opp_id = item["opponentId"]
            wr_em = item["winRate"]
            wr_go = matchups_go.get(opp_id, wr_em)
            easy_matchups.append({
                "opponentId": opp_id,
                "winRateEmerald": wr_em,
                "winRateGold": wr_go,
                "plays": item["plays"],
                "isSolidPick": bool(wr_em >= 52.0 and wr_go >= 51.5),
            })

        # ゴル以下 (gold) 専用の厳密ソート済み Top 5
        if go_counter_entries:
            sorted_go_hard = sorted(go_counter_entries, key=lambda x: (x["winRate"], -x["plays"]))
            hard_counters_gold = []
            for item in sorted_go_hard[:5]:
                opp_id = item["opponentId"]
                wr_go = item["winRate"]
                wr_em = matchups_em.get(opp_id, wr_go)
                hard_counters_gold.append({
                    "opponentId": opp_id,
                    "winRateEmerald": wr_em,
                    "winRateGold": wr_go,
                    "plays": item["plays"],
                    "isSolidPick": bool(wr_em <= 48.0 and wr_go <= 48.5),
                })

            sorted_go_easy = sorted(go_counter_entries, key=lambda x: (-x["winRate"], -x["plays"]))
            easy_matchups_gold = []
            for item in sorted_go_easy[:5]:
                opp_id = item["opponentId"]
                wr_go = item["winRate"]
                wr_em = matchups_em.get(opp_id, wr_go)
                easy_matchups_gold.append({
                    "opponentId": opp_id,
                    "winRateEmerald": wr_em,
                    "winRateGold": wr_go,
                    "plays": item["plays"],
                    "isSolidPick": bool(wr_em >= 52.0 and wr_go >= 51.5),
                })
        else:
            hard_counters_gold = hard_counters
            easy_matchups_gold = easy_matchups

        # (E) おすすめコアビルド (上位3パターン)
        build_patterns = []
        pattern_labels = ["採用率No.1", "コア 2", "コア 3"]
        core_items_list = em_data.get("core_items", [])
        first_two_core_ids = set()

        for idx, c_entry in enumerate(core_items_list[:3]):
            c_ids = c_entry.get("ids", [])
            if idx == 0:
                first_two_core_ids.update(c_ids[:2])
            c_play = c_entry.get("play", 0)
            c_win = c_entry.get("win", 0)
            c_wr = round((c_win / c_play) * 100, 2) if c_play > 0 else overall_wr
            c_pick = round((c_entry.get("pick_rate") or 0) * 100, 2)
            items_objs = [{"name": get_item_name(iid), "icon": get_item_icon(iid)} for iid in c_ids]
            if items_objs:
                build_patterns.append({
                    "name": pattern_labels[idx] if idx < len(pattern_labels) else f"コア {idx+1}",
                    "pickRate": c_pick,
                    "winRate": c_wr,
                    "plays": c_play,
                    "coreItems": items_objs,
                })

        # (F) おすすめ靴 (OP.GG実戦上位2足)
        recommended_boots = []
        for idx, b_entry in enumerate(em_data.get("boots", [])[:2]):
            b_ids = b_entry.get("ids", [])
            if not b_ids:
                continue
            bid = b_ids[0]
            b_play = b_entry.get("play", 0)
            b_win = b_entry.get("win", 0)
            b_wr = round((b_win / b_play) * 100, 2) if b_play > 0 else overall_wr
            b_pick = round((b_entry.get("pick_rate") or 0) * 100, 2)
            recommended_boots.append({
                "name": get_item_name(bid),
                "icon": get_item_icon(bid),
                "pickRate": b_pick,
                "winRate": b_wr,
                "plays": b_play,
                "desc": f"採用 {b_pick:.2f}% / 勝率 {b_wr:.2f}%",
                "type": "primary" if idx == 0 else "secondary",
            })

        # (G) 推奨ペット / 初期アイテム (OP.GG starter_items の上位2選をそのまま正確に反映)
        pets = []
        for idx, s_entry in enumerate(em_data.get("starter_items", [])[:2]):
            s_ids = s_entry.get("ids", [])
            if not s_ids:
                continue
            s_play = s_entry.get("play", 0)
            s_win = s_entry.get("win", 0)
            s_wr = round((s_win / s_play) * 100, 2) if s_play > 0 else overall_wr
            s_pick = round((s_entry.get("pick_rate") or 0) * 100, 2)
            item_names = [get_item_name(sid) for sid in s_ids]
            item_icons = [get_item_icon(sid) for sid in s_ids]
            combined_name = " + ".join(item_names)
            pets.append({
                "name": combined_name,
                "icon": item_icons[0],
                "icons": item_icons,
                "pickRate": s_pick,
                "winRate": s_wr,
                "plays": s_play,
                "desc": f"採用 {s_pick:.2f}% / 勝率 {s_wr:.2f}%",
            })
        if not pets:
            pets.append({
                "name": "青ペット",
                "icon": get_item_icon(1102),
                "icons": [get_item_icon(1102)],
                "pickRate": 50.0,
                "winRate": overall_wr,
                "plays": 100,
                "desc": f"採用 50.00% / 勝率 {overall_wr:.2f}%",
            })

        # (H) サモナースペル (OP.GG実戦上位2選)
        summoner_spells = []
        for s_entry in em_data.get("summoner_spells", [])[:2]:
            s_ids = s_entry.get("ids", [])
            if not s_ids:
                continue
            s_play = s_entry.get("play", 0)
            s_win = s_entry.get("win", 0)
            s_wr = round((s_win / s_play) * 100, 2) if s_play > 0 else overall_wr
            s_pick = round((s_entry.get("pick_rate") or 0) * 100, 2)
            s_objs = [spell_map.get(sid, {"id": f"Spell_{sid}", "name": f"スペル({sid})", "icon": ""}) for sid in s_ids]
            combined_name = " + ".join([o["name"] for o in s_objs])
            summoner_spells.append({
                "name": combined_name,
                "spells": s_objs,
                "pickRate": s_pick,
                "winRate": s_wr,
                "plays": s_play,
                "desc": f"採用 {s_pick:.2f}% / 勝率 {s_wr:.2f}%",
            })
        if not summoner_spells:
            default_spells = [
                spell_map.get(4, {"name": "フラッシュ", "icon": f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VER}/img/spell/SummonerFlash.png"}),
                spell_map.get(11, {"name": "スマイト", "icon": f"https://ddragon.leagueoflegends.com/cdn/{DDRAGON_VER}/img/spell/SummonerSmite.png"})
            ]
            summoner_spells.append({
                "name": "フラッシュ + スマイト",
                "spells": default_spells,
                "pickRate": 99.0,
                "winRate": overall_wr,
                "plays": 1000,
                "desc": f"採用 99.00% / 勝率 {overall_wr:.2f}%",
            })

        # (I) ルーン詳細 (上位2構成を取得)
        runes_list = em_data.get("runes", [])
        rune_pages_list = []
        for r_entry in runes_list[:2]:
            p_tree_id = r_entry.get("primary_page_id", 8000)
            s_tree_id = r_entry.get("secondary_page_id", 8300)
            p_rune_ids = r_entry.get("primary_rune_ids", [])
            s_rune_ids = r_entry.get("secondary_rune_ids", [])
            stat_mod_ids = r_entry.get("stat_mod_ids", [])

            keystone_id = p_rune_ids[0] if p_rune_ids else 8010
            ks_info = rune_perk_map.get(keystone_id, {"name": "征服者", "icon": "https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/Precision/Conqueror/Conqueror.png"})

            main_tree_info = rune_tree_map.get(p_tree_id, {"name": "精密", "icon": ""})
            sub_tree_info = rune_tree_map.get(s_tree_id, {"name": "天啓", "icon": ""})

            primary_runes_data = []
            for idx, rid in enumerate(p_rune_ids):
                r_data = rune_perk_map.get(rid, {"name": f"ルーン({rid})", "icon": ""})
                primary_runes_data.append({
                    "id": rid,
                    "name": r_data["name"],
                    "icon": r_data["icon"],
                    "isKeystone": (idx == 0)
                })

            secondary_runes_data = []
            for rid in s_rune_ids:
                r_data = rune_perk_map.get(rid, {"name": f"ルーン({rid})", "icon": ""})
                secondary_runes_data.append({
                    "id": rid,
                    "name": r_data["name"],
                    "icon": r_data["icon"]
                })

            shards_data = []
            for sid in stat_mod_ids:
                shards_data.append({
                    "id": sid,
                    "name": stat_mod_names.get(sid, "ステータス破片"),
                    "icon": f"https://opgg-static.akamaized.net/meta/images/lol/{DDRAGON_VER}/perkShard/{sid}.png"
                })

            r_play = r_entry.get("play", 0)
            r_win = r_entry.get("win", 0)
            r_wr = round((r_win / r_play) * 100, 2) if r_play > 0 else overall_wr
            r_pick = round((r_entry.get("pick_rate") or 0) * 100, 2)

            main_sub_names = [r["name"] for r in primary_runes_data[1:]]
            sub_rune_names = [r["name"] for r in secondary_runes_data]

            rune_pages_list.append({
                "keystoneName": ks_info["name"],
                "keystoneIcon": ks_info["icon"],
                "mainTree": main_tree_info["name"],
                "mainTreeIcon": main_tree_info["icon"],
                "subTree": sub_tree_info["name"],
                "subTreeIcon": sub_tree_info["icon"],
                "primaryRunes": primary_runes_data,
                "secondaryRunes": secondary_runes_data,
                "statShards": shards_data,
                "mainRunes": " / ".join(main_sub_names),
                "details": " / ".join(sub_rune_names) if sub_rune_names else "魔法の靴 / 宇宙の英知",
                "pickRate": r_pick,
                "winRate": r_wr,
                "plays": r_play,
            })

        if rune_pages_list:
            runes_obj = rune_pages_list[0]
        else:
            runes_obj = {
                "keystoneName": "征服者",
                "keystoneIcon": "https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/Precision/Conqueror/Conqueror.png",
                "mainTree": "精密",
                "mainTreeIcon": "",
                "subTree": "天啓",
                "subTreeIcon": "",
                "primaryRunes": [{"name": "征服者", "icon": "https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/Precision/Conqueror/Conqueror.png", "isKeystone": True}],
                "secondaryRunes": [],
                "statShards": [],
                "mainRunes": "凱旋 / レジェンド: 迅速 / 最期の慈悲",
                "details": "魔法の靴 / 宇宙の英知",
                "pickRate": 50.0,
                "winRate": overall_wr,
                "plays": 100,
            }
            rune_pages_list = [runes_obj]

        # (J) 初動スキル順 (Lv1〜5) & スキル優先度
        skills_list = em_data.get("skills", [])
        masteries_list = em_data.get("skill_masteries", [])
        levels1to5 = ["Q", "W", "E", "Q", "Q"]
        if skills_list and len(skills_list[0].get("order", [])) >= 5:
            levels1to5 = skills_list[0]["order"][:5]
        priority_str = " > ".join(masteries_list[0].get("ids", ["Q", "W", "E"])[:3]) if masteries_list else "Q > W > E"

        # (K) 4番目のアイテム / 5番目のアイテム / 6番目のアイテム (OP.GG 3列テーブル完全対応)
        fourth_core_options = []
        for l_entry in em_data.get("last_items", []):
            l_ids = l_entry.get("ids", [])
            if not l_ids:
                continue
            iid = l_ids[0]
            if iid in first_two_core_ids or iid not in completed_items_set:
                continue
            l_play = l_entry.get("play", 0)
            l_win = l_entry.get("win", 0)
            if l_play < 5:
                continue
            l_wr = round((l_win / l_play) * 100, 2)
            l_pick = round((l_entry.get("pick_rate") or 0) * 100, 2)
            fourth_core_options.append({
                "id": iid,
                "name": get_item_name(iid),
                "icon": get_item_icon(iid),
                "pickRate": l_pick,
                "winRate": l_wr,
                "plays": l_play,
            })
            if len(fourth_core_options) >= 15:
                break

        fourth_items = nth_items_data.get("fourthItems") or fourth_core_options[:5]
        fifth_items = nth_items_data.get("fifthItems") or fourth_core_options[5:10] or fourth_core_options[:5]
        sixth_items = nth_items_data.get("sixthItems") or fourth_core_options[10:15] or fourth_core_options[:5]

        existing_stats = lol_data.get("stats", {}).get(cid, {})
        changes_obj = existing_stats.get("changes", {"hasChanges": False})

        return cid, {
            "championId": cid,
            "overallWinRate": overall_wr,
            "overallWinRateGold": overall_wr_gold,
            "pickRate": pick_rate,
            "banRate": ban_rate,
            "timeWinRates": time_win_rates,
            "matchups": matchups_em,
            "matchupsGold": matchups_go,
            "hardCounters": hard_counters,
            "easyMatchups": easy_matchups,
            "hardCountersGold": hard_counters_gold,
            "easyMatchupsGold": easy_matchups_gold,
            "build": {
                "spells": summoner_spells,
                "summonerSpells": summoner_spells,
                "pets": pets,
                "pet": pets[0],
                "boots": recommended_boots[0] if recommended_boots else {"name": "アイオニア ブーツ", "icon": get_item_icon(3158)},
                "recommendedBoots": recommended_boots,
                "runes": runes_obj,
                "runePages": rune_pages_list,
                "skillOrder": {
                    "priority": priority_str,
                    "levels1to5": levels1to5,
                },
                "buildPatterns": build_patterns,
                "fourthCoreOptions": fourth_core_options[:6],
                "fourthItems": fourth_items[:5],
                "fifthItems": fifth_items[:5],
                "sixthItems": sixth_items[:5],
                "coreItems": build_patterns[0]["coreItems"] if build_patterns else [],
            },
            "changes": changes_obj,
        }

    database = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(fetch_single_jg_champ, cid): cid for cid in jg_list_sorted}
        done_cnt = 0
        for future in as_completed(futures):
            done_cnt += 1
            cid = futures[future]
            try:
                _, res_entry = future.result()
                if res_entry:
                    database[cid] = res_entry
                    b = res_entry["build"]
                    print(f"  [{done_cnt:2d}/{len(jg_list_sorted)}] {cid:14s} 完了 (勝率: {res_entry['overallWinRate']:.2f}%, 4/5/6コア: {len(b['fourthItems'])}/{len(b['fifthItems'])}/{len(b['sixthItems'])}件)")
                else:
                    print(f"  [{done_cnt:2d}/{len(jg_list_sorted)}] {cid:14s} スキップ (APIデータなし)")
            except Exception as e:
                print(f"  [{done_cnt:2d}/{len(jg_list_sorted)}] {cid:14s} エラー: {e}")

    if "MonkeyKing" in database:
        database["Wukong"] = database["MonkeyKing"]

    # 5. ファイル出力 (opgg_stats.json, opgg_stats.js, data.js)
    print("[4/4] ファイル書き出し中...")
    lol_data["stats"] = database

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(database, f, ensure_ascii=False, indent=2)

    with open(js_path, "w", encoding="utf-8") as f:
        f.write("/** OP.GG 公式実戦統計データ (file:// 対応スクリプト) */\n")
        f.write("window.OPGG_STATS_DATABASE = ")
        json.dump(database, f, ensure_ascii=False, indent=2)
        f.write(";\n")

    with open(data_js_path, "w", encoding="utf-8") as f:
        f.write("/**\n * LoL Jungle Tactical Companion - Master Data\n * 五十音順・OP.GG公式ロール・実戦統計完全同期版\n */\n")
        f.write("window.LOL_DATA = ")
        json.dump(lol_data, f, ensure_ascii=False, indent=2)
        f.write(";\n")

    print("=" * 68)
    print(f"完了！ 収録JGチャンピオン数: {len(database)}体")
    print(f"  - data.js        : {os.path.getsize(data_js_path):,} bytes")
    print(f"  - opgg_stats.js  : {os.path.getsize(js_path):,} bytes")
    print(f"  - opgg_stats.json: {os.path.getsize(json_path):,} bytes")
    print("=" * 68)

if __name__ == "__main__":
    main()
