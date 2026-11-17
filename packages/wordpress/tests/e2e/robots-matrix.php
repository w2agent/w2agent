<?php
// Test-only. Run with `wp eval-file` while both plugins are active: prints what each plugin copy
// would append to every robots.txt case in robots-cases.json, as JSON for robots-matrix.mjs.
$cases = json_decode(file_get_contents(ABSPATH . 'w2a-robots-cases.json'), true);
$rows = [];
foreach ($cases as $case) {
    $rows[] = [
        'name'       => $case['name'],
        'generated'  => w2agent_site_robots_additions($case['robots']),
        'standalone' => w2agent_robots_additions($case['robots']),
    ];
}
echo json_encode($rows);
