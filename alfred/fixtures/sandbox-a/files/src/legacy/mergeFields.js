// mergeFields — legacy templating, kept from the v2 notification service.

const TOKEN = /\{\{(\w+)\}\}/g;

export function mergeFields(template, values) {
  return template.replace(TOKEN, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return String(values[key]);
    }
    return whole;
  });
}

export function listTokens(template) {
  var found = [];
  for (const match of template.matchAll(TOKEN)) {
    found.push(match[1]);
  }
  return found;
}
