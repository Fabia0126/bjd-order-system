const {test}=require('node:test');
const assert=require('node:assert/strict');
const {state,isDemo}=require('../receipt-ui.js');
test('A winning entry uses current fulfilment status instead of always showing waiting',()=>{
    assert.deepEqual(state({status:'won',order_status:'working'}),{label:'正在施工',tone:'working'});
    assert.deepEqual(state({status:'won',order_status:'packing'}),{label:'已确认待打包',tone:'packing'});
    assert.deepEqual(state({status:'won',order_status:'completed'}),{label:'已完成',tone:'completed'});
    assert.deepEqual(state({status:'won',order_status:null}),{label:'等待中',tone:'approved'});
});
test('Submission, review and rejection stay distinct; demo is a separate label',()=>{
    assert.equal(state({status:'received'}).tone,'received');
    assert.equal(state({status:'reviewing'}).tone,'pending');
    assert.equal(state({status:'not_selected'}).tone,'rejected');
    assert.equal(state({status:'rejected'}).tone,'rejected');
    assert.equal(isDemo({status:'won',order_id:'DEMO-fixture-001'}),true);
    assert.equal(state({status:'__proto__'}).label,'状态待查询');
});
