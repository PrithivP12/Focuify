from focuify_model.metrics import choose_thresholds, evaluate_scores, release_checks


def test_good_separation_passes_release_checks():
    labels = [0, 0, 0, 0, 1, 1, 1, 1]
    scores = [0.01, 0.02, 0.03, 0.04, 0.8, 0.9, 0.95, 0.99]
    thresholds = choose_thresholds(labels, scores)
    metrics = evaluate_scores(labels, scores, thresholds)
    assert all(release_checks(metrics).values())
