/** @jsx createElement */

import { createElement } from "./webviewHtml";

export interface PathListProperties {
  id: string;
  label: string;
  paths: readonly string[];
  placeholder: string;
  required?: boolean;
}

export function PathList(properties: PathListProperties): JSX.Element {
  const paths = [...properties.paths, ""];
  const populatedCount = properties.paths.length;
  return <div
    id={properties.id}
    className="path-list"
    data-path-list="true"
    data-label={properties.label}
    data-required={properties.required === true}
    data-reorderable={populatedCount > 1}
  >
    <div className="path-list-label">{properties.label}</div>
    <div className="path-list-rows">
      {paths.map((path, index) => <div className="path-list-row" data-path-list-row data-index={index}>
        <span className="path-list-index" aria-hidden="true">[{index}]</span>
        <input
          type="text"
          value={path}
          placeholder={properties.placeholder}
          aria-label={`${properties.label} path ${index}`}
          data-path-list-input
          data-index={index}
        />
        <button
          className="secondary path-list-button"
          type="button"
          title="Select path"
          aria-label={`Select ${properties.label.toLowerCase()} path ${index}`}
          data-path-list-action="browse"
          data-index={index}
        >…</button>
        <button
          className={`secondary path-list-button path-list-reorder${index === 0 || index >= populatedCount ? " path-list-button-hidden" : ""}`}
          type="button"
          title="Move up"
          aria-label={`Move ${properties.label.toLowerCase()} path ${index} up`}
          data-path-list-action="moveUp"
          data-index={index}
        >↑</button>
        <button
          className={`secondary path-list-button path-list-reorder${index >= populatedCount - 1 ? " path-list-button-hidden" : ""}`}
          type="button"
          title="Move down"
          aria-label={`Move ${properties.label.toLowerCase()} path ${index} down`}
          data-path-list-action="moveDown"
          data-index={index}
        >↓</button>
        <button
          className={`secondary path-list-button${index >= populatedCount ? " path-list-button-hidden" : ""}`}
          type="button"
          title="Clear"
          aria-label={`Clear ${properties.label.toLowerCase()} path ${index}`}
          data-path-list-action="remove"
          data-index={index}
        >×</button>
      </div>)}
    </div>
  </div>;
}
