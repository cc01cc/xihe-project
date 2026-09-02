#[cfg(test)]
mod tests {
    #[test]
    fn test_artifact_store_api() {
        let id = xihe_runtime::sandbox::store_artifact("artifact", 1);
        let lines = xihe_runtime::sandbox::read_artifact(&id, None, None).unwrap();
        assert_eq!(lines, vec!["artifact"]);
    }
}
