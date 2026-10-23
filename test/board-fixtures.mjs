export function boardTask(store, id, number, kind, status, options={}) {
  const {repo='101',time='2026-10-01T12:00:00.000Z',title=`Fixture ${number}`,input={},result=null}=options;
  store.run(`INSERT INTO tasks(id,repository_id,object_number,kind,status,summary,input,result,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,id,repo,number,kind,status,id,JSON.stringify({title,...input}),result?JSON.stringify(result):null,time,time);
}
export function boardFixtures(store) {
  boardTask(store,'reviewed',1,'review.issue','succeeded',{title:'Only successful review'});
  boardTask(store,'reviewing',2,'review.pr','running',{title:'Review in progress'});
  boardTask(store,'source-review',3,'review.issue','succeeded',{title:'Develop this Issue'});
  boardTask(store,'developing',3,'development.issue','implementing',{title:'Develop this Issue'});
  boardTask(store,'developed-review',4,'review.issue','succeeded',{title:'Development has PR'});
  boardTask(store,'developed',4,'development.issue','pr_opened',{title:'Development has PR',result:{pr_number:40}});
  boardTask(store,'failed-review',5,'review.issue','failed',{title:'Review failed'});
  boardTask(store,'foreign-review',1,'review.issue','succeeded',{repo:'202',title:'Foreign private card'});
}
