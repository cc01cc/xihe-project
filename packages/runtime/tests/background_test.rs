use xihe_runtime::sandbox::{
    get_background_process, list_background_processes, register_background_process,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_background_process_register_and_get() {
        let pid = register_background_process("ws-1", "echo hello");
        let proc = get_background_process(&pid);
        assert!(proc.is_some());
        let proc = proc.unwrap();
        assert_eq!(proc.ws_id, "ws-1");
        assert_eq!(proc.command, "echo hello");
        assert_eq!(proc.status, "running");
    }

    #[test]
    fn test_background_process_list_by_ws() {
        let pid1 = register_background_process("ws-a", "cmd1");
        let pid2 = register_background_process("ws-a", "cmd2");
        register_background_process("ws-b", "cmd3");

        let procs = list_background_processes("ws-a");
        assert_eq!(procs.len(), 2);
        assert!(procs.iter().any(|p| p.pid == pid1));
        assert!(procs.iter().any(|p| p.pid == pid2));
    }

    #[test]
    fn test_background_process_status() {
        let pid = register_background_process("ws-s", "sleep 10");
        let proc = get_background_process(&pid).unwrap();
        assert_eq!(proc.status, "running");
    }

    #[test]
    fn test_background_process_get_nonexistent() {
        let proc = get_background_process("nonexistent-pid");
        assert!(proc.is_none());
    }

    #[test]
    fn test_background_process_list_empty_ws() {
        let procs = list_background_processes("non-existent-ws");
        assert!(procs.is_empty());
    }
}
