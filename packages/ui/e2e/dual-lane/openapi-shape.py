"""双侧轨迹对账（task-50）—— 契约车道：从 openapi.yaml 推「这一侧应该是什么形状」。

为什么用 Python：workspace 明令「解析成熟文件格式必须用成熟库或原生机制，禁止手写 parser」，
本仓解析 openapi 的唯一先例就是 PyYAML（`A03-xihe/scripts/gen-api-docs.mjs:14-18` 写明理由）。

输入：argv[1] = openapi.yaml 路径，argv[2] = JSON 数组 `[{method, path}]`（path 已归一化，id 段为 {id}）。
输出：JSON 数组，逐条给 `status` / `keys`（响应顶层键，排序）/ `itemKeys`（数组元素键，仅供人看）。
"""
import json
import sys

import yaml


def deref(doc, node, depth=0):
    if not isinstance(node, dict) or depth > 12:
        return node if isinstance(node, dict) else {}
    ref = node.get("$ref")
    if isinstance(ref, str):
        if not ref.startswith("#/"):
            return {}
        cur = doc
        for part in ref[2:].split("/"):
            cur = cur.get(part, {}) if isinstance(cur, dict) else {}
        return deref(doc, cur, depth + 1)
    all_of = node.get("allOf")
    if isinstance(all_of, list):
        merged = {"type": "object", "properties": {}}
        for sub in all_of:
            part = deref(doc, sub, depth + 1)
            merged["properties"].update(part.get("properties") or {})
            if "type" in part:
                merged["type"] = part["type"]
        return merged
    return node


def shape(doc, schema):
    resolved = deref(doc, schema or {})
    kind = resolved.get("type")
    if isinstance(kind, list):
        kinds = [item for item in kind if item != "null"]
        kind = kinds[0] if kinds else None
    if kind == "array":
        item = deref(doc, resolved.get("items") or {})
        return ["<array>"], sorted((item.get("properties") or {}).keys())
    props = resolved.get("properties") or {}
    if props:
        return sorted(props.keys()), []
    return [], []


def normalize(path):
    return "/".join("{id}" if seg.startswith("{") and seg.endswith("}") else seg for seg in path.split("/"))


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        doc = yaml.safe_load(handle)
    wanted = json.loads(sys.argv[2])
    paths = doc.get("paths") or {}
    out = []
    for want in wanted:
        method = want["method"].lower()
        target = want["path"]
        hit = None
        for raw_path, item in paths.items():
            if not isinstance(item, dict):
                continue
            if normalize(raw_path) == target and method in item:
                hit = item[method]
                break
        if hit is None:
            out.append({"method": want["method"], "path": target, "status": None, "keys": None,
                        "itemKeys": [], "operationId": None, "error": "not-in-contract"})
            continue
        responses = hit.get("responses") or {}
        code = None
        spec = None
        for key in sorted(responses, key=str):
            if str(key).startswith("2"):
                code = int(key)
                spec = responses[key]
                break
        if code is None:
            out.append({"method": want["method"], "path": target, "status": None, "keys": None,
                        "itemKeys": [], "operationId": hit.get("operationId"), "error": "no-2xx-declared"})
            continue
        schema = None
        if isinstance(spec, dict):
            media = (spec.get("content") or {}).get("application/json") or {}
            schema = media.get("schema")
        keys, item_keys = shape(doc, schema)
        out.append({"method": want["method"], "path": target, "status": code, "keys": keys,
                    "itemKeys": item_keys, "operationId": hit.get("operationId"), "error": None})
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
