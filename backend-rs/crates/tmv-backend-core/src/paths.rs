use crate::{FolderIdentity, ENCODE_URI_COMPONENT_SET};
use anyhow::{anyhow, Result};
use percent_encoding::utf8_percent_encode;
use std::path::{Component, Path};

pub(crate) fn encode_path(value: &str) -> String {
    value
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| utf8_percent_encode(segment, ENCODE_URI_COMPONENT_SET).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn normalize_relative_path(input: &str) -> Result<String> {
    let normalized = input
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if normalized.is_empty() {
        return Ok(String::new());
    }

    let path = Path::new(&normalized);
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => return Err(anyhow!("Path escapes media root")),
            _ => return Err(anyhow!("Path escapes media root")),
        }
    }
    Ok(parts.join("/"))
}

pub(crate) fn folder_identity(root: &Path, safe_relative_path: &str) -> FolderIdentity {
    FolderIdentity {
        name: basename_or_root(safe_relative_path, root),
        path: safe_relative_path.to_string(),
    }
}

pub(crate) fn basename_or_root(relative_path: &str, root: &Path) -> String {
    if relative_path.is_empty() {
        return root
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "root".to_string());
    }
    relative_path
        .rsplit('/')
        .next()
        .map(ToString::to_string)
        .unwrap_or_else(|| "root".to_string())
}

pub(crate) fn build_breadcrumb(relative_path: &str) -> Vec<FolderIdentity> {
    let mut breadcrumb = vec![FolderIdentity {
        name: "root".to_string(),
        path: String::new(),
    }];
    let mut current = String::new();
    for segment in relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
    {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(segment);
        breadcrumb.push(FolderIdentity {
            name: segment.to_string(),
            path: current.clone(),
        });
    }
    breadcrumb
}

pub(crate) fn dedupe_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let trimmed = path.trim().replace('\\', "/");
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.clone()) {
            result.push(trimmed);
        }
    }
    result
}

pub(crate) fn join_relative(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

pub(crate) fn collect_path_and_ancestors(path: &str) -> Vec<String> {
    let mut collected = Vec::new();
    let mut current = Some(path.to_string());
    while let Some(value) = current.take() {
        collected.push(value.clone());
        current = if value.is_empty() {
            None
        } else {
            Some(
                value
                    .rsplit_once('/')
                    .map(|(parent, _)| parent.to_string())
                    .unwrap_or_default(),
            )
        };
    }
    collected
}
