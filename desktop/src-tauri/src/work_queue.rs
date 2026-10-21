//! Bounded workers keep slots busy without reordering results or scheduling after failure.
use std::sync::Mutex;

pub(crate) fn run<T: Sync, R: Send>(
    items: &[T],
    width: usize,
    work: impl Fn(&T) -> Result<R, String> + Sync,
) -> Result<Vec<R>, String> {
    struct State<R> {
        next: usize,
        failed: bool,
        results: Vec<Option<Result<R, String>>>,
    }
    let state = Mutex::new(State {
        next: 0,
        failed: false,
        results: (0..items.len()).map(|_| None).collect(),
    });
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..width.max(1).min(items.len()))
            .map(|_| {
                let state = &state;
                let work = &work;
                scope.spawn(move || -> Result<(), String> {
                    loop {
                        let index = {
                            let mut state = state.lock().map_err(|_| {
                                "transcription worker state was poisoned".to_string()
                            })?;
                            if state.failed || state.next == items.len() {
                                break;
                            }
                            let index = state.next;
                            state.next += 1;
                            index
                        };
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            work(&items[index])
                        }))
                        .unwrap_or_else(|_| Err("transcription worker panicked".into()));
                        let mut state = state
                            .lock()
                            .map_err(|_| "transcription worker state was poisoned".to_string())?;
                        state.failed |= result.is_err();
                        state.results[index] = Some(result);
                    }
                    Ok(())
                })
            })
            .collect();
        let mut error = None;
        for worker in workers {
            if let Err(message) = worker
                .join()
                .unwrap_or_else(|_| Err("transcription worker panicked".into()))
            {
                if error.is_none() {
                    error = Some(message);
                }
            }
        }
        match error {
            Some(message) => Err(message),
            None => Ok(()),
        }
    })?;
    let state = state
        .into_inner()
        .map_err(|_| "transcription worker state was poisoned".to_string())?;
    let mut result = Vec::with_capacity(items.len());
    for entry in state.results.into_iter().flatten() {
        result.push(entry?);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::Duration;

    #[test]
    fn replaces_finished_work_before_a_straggler_finishes_and_keeps_order() {
        let (tx, rx) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let wait = Mutex::new(wait);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                run(&[0, 1, 2, 3, 4, 5], 3, |&i| {
                    if i == 0 {
                        wait.lock().unwrap().recv().unwrap();
                    }
                    if i == 3 {
                        tx.send(()).unwrap();
                    }
                    Ok(i)
                })
            });
            let started_next = rx.recv_timeout(Duration::from_secs(5));
            release.send(()).unwrap();
            assert!(
                started_next.is_ok(),
                "next batch must start before task 0 finishes"
            );
            assert_eq!(worker.join().unwrap().unwrap(), vec![0, 1, 2, 3, 4, 5]);
        });
    }
    #[test]
    fn bounds_concurrency_and_stops_claiming_after_failure() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let result = run(&(0..30).collect::<Vec<_>>(), 3, |&i| {
            let n = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(2));
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(i)
        })
        .unwrap();
        assert_eq!(result.len(), 30);
        assert!(peak.load(Ordering::SeqCst) <= 3);
        let calls = AtomicUsize::new(0);
        let result = run(&[0, 1, 2, 3], 1, |&i| {
            calls.fetch_add(1, Ordering::SeqCst);
            if i == 1 {
                Err("failure".into())
            } else {
                Ok(i)
            }
        });
        assert_eq!(result, Err("failure".into()));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(run::<usize, usize>(&[], 0, |&i| Ok(i)).unwrap().is_empty());
        assert_eq!(run(&[1], 0, |&i| Ok(i)).unwrap(), vec![1]);
        assert_eq!(
            run(&[0, 1], 1, |_| -> Result<usize, String> { panic!("test") }),
            Err("transcription worker panicked".into())
        );
    }
}
