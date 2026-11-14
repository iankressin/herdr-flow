export function parseAgentResult(text, produces = []) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        return { error: `The result file is not valid JSON: ${error.message}` };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return { error: "The result file must hold one JSON object" };
    const { outcome, summary, values } = raw;
    if (outcome !== "pass" && outcome !== "fail")
        return { error: `outcome must be "pass" or "fail", not ${JSON.stringify(outcome)}` };
    if (typeof summary !== "string" || !summary.trim())
        return { error: "summary must be a non-empty string" };
    if (values != null && (typeof values !== "object" || Array.isArray(values)))
        return { error: "values must be an object" };
    const given = (values ?? {});
    const kept = {};
    for (const key of produces) {
        const value = given[key];
        if (value == null) {
            if (outcome === "pass")
                return { error: `values.${key} is missing` };
            kept[key] = "";
        }
        else {
            kept[key] = typeof value === "string" ? value : JSON.stringify(value);
        }
    }
    return { outcome, summary: summary.trim(), values: kept };
}
